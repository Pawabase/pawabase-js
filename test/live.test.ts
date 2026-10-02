/**
 * Contract tests against a real, running Pawabase stack.
 *
 *   PAWABASE_LIVE_CONFIG=/path/to/config.json npm test
 *
 * The config (url, project, environment, publishable, secret) is written by
 * scripts/live-provision.py after the stack is up. Without it these tests are skipped.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import {
  AuthenticationError,
  ConflictError,
  MemoryStorage,
  NotFoundError,
  PermissionError,
  RealtimeError,
  ValidationError,
  createClient,
  type PawabaseClient,
} from "../src/index.js";
import { until } from "./helpers.js";

const configPath = process.env["PAWABASE_LIVE_CONFIG"];
const live = configPath ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, string>) : null;

interface Post {
  id: number;
  title: string;
  status: string;
  views: number;
  featured: boolean;
  org_id: string | null;
  author_id: number | null;
  meta: unknown;
  author?: { id: number; name: string } | null;
}
interface Task {
  id: number;
  title: string;
  owner_id: string;
}
type DB = {
  resources: {
    posts: { Row: Post; Insert: Partial<Omit<Post, "id">> & { title: string }; Update: Partial<Omit<Post, "id">> };
    tasks: { Row: Task; Insert: { title: string }; Update: { title?: string } };
    authors: { Row: { id: number; name: string }; Insert: { name: string }; Update: { name?: string } };
  };
};

const clients: Array<PawabaseClient<DB>> = [];
function newClient(key: "publishable" | "secret" = "publishable", extra: Record<string, unknown> = {}): PawabaseClient<DB> {
  const client = createClient<DB>({
    url: live!["url"]!,
    apiKey: live![key]!,
    project: live!["project"]!,
    environment: live!["environment"]!,
    auth: { storage: new MemoryStorage(), autoRefreshToken: false },
    ...extra,
  });
  clients.push(client);
  return client;
}
after(() => clients.forEach((client) => client.dispose()));

const unique = () => Math.random().toString(36).slice(2, 8);

describe("live: data", { skip: !live }, () => {
  test("create, read, filter, order, update, delete", async () => {
    const db = newClient();
    const tag = unique();
    const a = await db.from("posts").create({ title: `a-${tag}`, status: "live", views: 5, featured: true });
    const b = await db.from("posts").create({ title: `b-${tag}`, status: "live", views: 50, featured: false });
    const c = await db.from("posts").create({ title: `c-${tag}`, status: "draft", views: 500 });
    try {
      assert.equal(a.featured, true);
      assert.equal(c.featured, false, "defaults apply");

      const live = await db.from("posts").eq("status", "live").like("title", `*-${tag}`).order("views", "desc");
      assert.deepEqual(live.data.map((p) => p.id), [b.id, a.id]);
      assert.equal(live.total, 2);

      // The server's eq.false matches the wrong rows; the client sends is.false.
      const notFeatured = await db.from("posts").eq("featured", false).like("title", `*-${tag}`).all();
      assert.deepEqual(notFeatured.map((p) => p.id).sort(), [b.id, c.id].sort());
      const featured = await db.from("posts").is("featured", true).like("title", `*-${tag}`).all();
      assert.deepEqual(featured.map((p) => p.id), [a.id]);

      const big = await db.from("posts").gte("views", 50).like("title", `*-${tag}`).all();
      assert.equal(big.length, 2);
      const some = await db.from("posts").in("id", [a.id, c.id]).order("id").all();
      assert.deepEqual(some.map((p) => p.id), [a.id, c.id]);
      const none = await db.from("posts").in("id", []).all();
      assert.equal(none.length, 0);
      const nullOrg = await db.from("posts").eq("org_id", null).like("title", `*-${tag}`).count();
      assert.equal(nullOrg, 3);

      assert.equal((await db.from("posts").get(a.id)).title, `a-${tag}`);
      const updated = await db.from("posts").update(a.id, { views: 6, meta: { k: [1, 2] } });
      assert.equal(updated.views, 6);
      assert.deepEqual(updated.meta, { k: [1, 2] });

      const selected = await db.from("posts").eq("status", "live").like("title", `*-${tag}`).select("title").first();
      assert.ok(selected && "title" in selected && "id" in selected);
      assert.equal(selected.views, null, "columns you did not select come back null");
    } finally {
      for (const row of [a, b, c]) await db.from("posts").delete(row.id);
    }
    await assert.rejects(db.from("posts").get(a.id), NotFoundError);
    assert.equal(await db.from("posts").maybeGet(a.id), null);
  });

  test("a range on one field is refused by the client, since the server would drop a bound", async () => {
    const db = newClient();
    assert.throws(() => db.from("posts").gte("views", 1).lte("views", 3));
  });

  test("paging, iteration and expand", async () => {
    const db = newClient();
    const tag = unique();
    const author = await db.from("authors").create({ name: `Ada-${tag}` });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await db.from("posts").create({ title: `p${i}-${tag}`, author_id: author.id })).id);
    try {
      const query = db.from("posts").like("title", `*-${tag}`).order("id");
      const first = await query.perPage(2).page(1);
      assert.equal(first.data.length, 2);
      assert.equal(first.total, 5);
      const streamed: number[] = [];
      for await (const row of db.from("posts").like("title", `*-${tag}`).order("id").perPage(2)) streamed.push(row.id);
      assert.deepEqual(streamed, ids);
      const withAuthor = await db.from("posts").get(ids[0]!, { expand: ["author"] });
      assert.equal(withAuthor.author?.name, `Ada-${tag}`);
      const listed = await db.from("posts").like("title", `*-${tag}`).expand("author").first();
      assert.equal(listed?.author?.id, author.id);
    } finally {
      for (const id of ids) await db.from("posts").delete(id);
      await db.from("authors").delete(author.id);
    }
  });

  test("createMany creates in parallel and reports failures", async () => {
    const db = newClient();
    const tag = unique();
    const result = await db.from("posts").createMany([{ title: `m1-${tag}` }, { title: undefined as unknown as string }, { title: `m3-${tag}` }]);
    try {
      assert.equal(result.created.length, 2);
      assert.equal(result.failed.length, 1);
      assert.ok(result.failed[0]!.error instanceof ValidationError);
    } finally {
      for (const row of result.created) await db.from("posts").delete(row.id);
    }
  });

  test("validation errors list fields", async () => {
    const db = newClient();
    await assert.rejects(db.from("posts").create({} as never), (e: unknown) => e instanceof ValidationError && e.fieldError("title") === "Field required" && e.requestId !== null);
  });

  test("a filter on an unknown field is a 400 the client reports", async () => {
    const db = newClient();
    await assert.rejects(db.from("posts").filter("nope", "eq", 1).execute(), (e: unknown) => (e as { status: number }).status === 400);
  });

  test("a wrong API key is a typed gateway error", async () => {
    const db = createClient({ url: live!["url"]!, apiKey: "pb_pk_wrong", retry: false });
    await assert.rejects(db.from("posts").list(), (e: unknown) => e instanceof AuthenticationError && e.code === "invalid_api_key");
    db.dispose();
  });
});

describe("live: auth and policies", { skip: !live }, () => {
  test("sign up, sign in, session lifecycle, profile", async () => {
    const db = newClient();
    const email = `sdk-${unique()}@example.com`;
    const password = "Sdk!pass-1234";
    const events: string[] = [];
    db.auth.onAuthStateChange((event) => events.push(event));
    const signedUp = await db.auth.signUp({ email, password, data: { theme: "dark" } });
    assert.equal(signedUp.session !== null, true);
    assert.equal(signedUp.user.user_metadata["theme"], "dark");
    const me = await db.auth.getUser();
    assert.equal(me.email, email);

    const updated = await db.auth.updateUser({ name: "Sdk Tester", data: { lang: "en" } });
    assert.equal(updated.name, "Sdk Tester");
    assert.deepEqual(updated.user_metadata, { theme: "dark", lang: "en" });

    const refreshed = await db.auth.refreshSession();
    assert.notEqual(refreshed.access_token, signedUp.session!.access_token);
    assert.ok(refreshed.expires_at > Date.now() / 1000);
    assert.ok((await db.auth.sessions.list()).some((s) => s.current));

    await db.auth.signOut();
    assert.equal(await db.auth.getSession(), null);
    await assert.rejects(db.auth.getUser(), AuthenticationError);
    assert.ok(events.includes("SIGNED_IN") && events.includes("TOKEN_REFRESHED") && events.includes("SIGNED_OUT"));

    const again = await db.auth.signInWithPassword({ email, password });
    assert.equal(again.status, "signed_in");
    await assert.rejects(newClient().auth.signInWithPassword({ email, password: "wrong-password" }), (e: unknown) => (e as { status: number }).status === 400);
    await assert.rejects(newClient().auth.signUp({ email, password }), ConflictError);
  });

  test("a stale access token is refreshed transparently, once, for concurrent requests", async () => {
    const db = newClient();
    const email = `sdk-${unique()}@example.com`;
    await db.auth.signUp({ email, password: "Sdk!pass-1234" });
    const refreshes: string[] = [];
    const hooked = newClient("publishable", { hooks: { onRequest: (info: { url: string }) => info.url.includes("/auth/v1/token") && refreshes.push(info.url) } });
    await hooked.auth.signInWithPassword({ email, password: "Sdk!pass-1234" });
    refreshes.length = 0;
    // Corrupt the access token the client holds; the refresh token is still good.
    // @ts-expect-error reach in
    hooked.auth.session = { ...hooked.auth.session, access_token: "x.y.z" };
    const results = await Promise.all([hooked.auth.getUser(), hooked.auth.getUser(), hooked.auth.getUser()]);
    assert.equal(results.every((u) => u.email === email), true);
    assert.equal(refreshes.length, 1, "three 401s, one refresh");
  });

  test("owner-scoped records: each user sees only their own", async () => {
    const ada = newClient();
    const bob = newClient();
    await ada.auth.signUp({ email: `ada-${unique()}@example.com`, password: "Sdk!pass-1234" });
    await bob.auth.signUp({ email: `bob-${unique()}@example.com`, password: "Sdk!pass-1234" });
    const mine = await ada.from("tasks").create({ title: "Ada's" });
    const his = await bob.from("tasks").create({ title: "Bob's" });
    try {
      assert.deepEqual((await ada.from("tasks").all()).map((t) => t.id), [mine.id]);
      assert.deepEqual((await bob.from("tasks").all()).map((t) => t.id), [his.id]);
      assert.equal(await ada.from("tasks").maybeGet(his.id), null);
      await assert.rejects(ada.from("tasks").update(his.id, { title: "mine now" }), (e: unknown) => e instanceof PermissionError && e.policy === "owner:owner_id");
      const anon = newClient();
      await assert.rejects(anon.from("tasks").all(), (e: unknown) => e instanceof AuthenticationError && e.status === 401);
    } finally {
      await ada.from("tasks").delete(mine.id);
      await bob.from("tasks").delete(his.id);
    }
  });

  test("asUser acts with a token you hold", async () => {
    const user = newClient();
    await user.auth.signUp({ email: `u-${unique()}@example.com`, password: "Sdk!pass-1234" });
    const token = (await user.auth.getSession())!.access_token;
    const server = newClient().asUser(token);
    clients.push(server);
    const row = await server.from("tasks").create({ title: "from the server" });
    assert.equal((await user.from("tasks").get(row.id)).title, "from the server");
    await user.from("tasks").delete(row.id);
  });

  test("a secret key bypasses policies", async () => {
    const admin = newClient("secret");
    const rows = await admin.from("tasks").all();
    assert.ok(Array.isArray(rows));
  });

  test("functions and flows", async () => {
    const db = newClient();
    assert.deepEqual(await db.functions.invoke("hello", { name: "SDK" }), { message: "Hello, SDK!", project: "demo", env: "development" });
    const who = await db.flows.run<{ auth: { authenticated: boolean } }>("whoami", { a: 1 });
    assert.equal(who.auth.authenticated, false);
    await assert.rejects(db.functions.invoke("nope"), NotFoundError);
    const user = newClient();
    await user.auth.signUp({ email: `f-${unique()}@example.com`, password: "Sdk!pass-1234" });
    const signedIn = await user.flows.run<{ auth: { authenticated: boolean; email: string } }>("whoami");
    assert.equal(signedIn.auth.authenticated, true);
  });

  test("auth settings are public", async () => {
    const settings = await newClient().auth.settings();
    assert.equal(typeof settings.signup_enabled, "boolean");
  });
});

describe("live: storage", { skip: !live }, () => {
  test("upload, list, download, delete in a public and a private bucket", async () => {
    const owner = newClient();
    await owner.auth.signUp({ email: `s-${unique()}@example.com`, password: "Sdk!pass-1234" });
    const key = `sdk/${unique()}/hello world.txt`;
    const bucket = owner.storage.from("pub");
    const stored = await bucket.upload(key, "hello storage", { contentType: "text/plain" });
    assert.equal(stored.size, 13);
    try {
      assert.equal(await bucket.downloadText(key), "hello storage");
      const listing = await bucket.list({ prefix: key.split("/").slice(0, 2).join("/") + "/" });
      assert.ok(listing.files.some((f) => f.key === key));
      const keys: string[] = [];
      for await (const file of bucket.listAll({ prefix: "sdk/" })) keys.push(file.key);
      assert.ok(keys.includes(key));

      // Public bucket: anyone with the (publishable) key in the URL can read it.
      const publicUrl = bucket.getPublicUrl(key);
      const response = await fetch(publicUrl);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "hello storage");
    } finally {
      await bucket.remove(key);
    }
    await assert.rejects(bucket.download(key), NotFoundError);
  });

  test("a private bucket refuses anonymous reads but serves a signed URL", async () => {
    const owner = newClient();
    await owner.auth.signUp({ email: `s-${unique()}@example.com`, password: "Sdk!pass-1234" });
    const key = `sdk/${unique()}.txt`;
    const bucket = owner.storage.from("private");
    await bucket.upload(key, "secret words");
    try {
      await assert.rejects(newClient().storage.from("private").download(key));
      const signed = await bucket.createSignedUrl(key, { expiresIn: 60 });
      const response = await fetch(signed.url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "secret words");
    } finally {
      await bucket.remove(key);
    }
  });

  test("a signed upload URL lets a keyless client upload exactly one object", async () => {
    const owner = newClient();
    await owner.auth.signUp({ email: `s-${unique()}@example.com`, password: "Sdk!pass-1234" });
    const key = `sdk/${unique()}.csv`;
    const bucket = owner.storage.from("private");
    const signed = await bucket.createSignedUploadUrl(key, { expiresIn: 60, contentType: "text/csv", maxBytes: 100 });
    const stored = await bucket.uploadToSignedUrl(signed.url, "a,b\n1,2", { contentType: "text/csv" });
    assert.equal(stored.key, key);
    assert.equal(await bucket.downloadText(key), "a,b\n1,2");
    await bucket.remove(key);
  });

  test("the bucket's size limit is enforced and surfaces as an error", async () => {
    const owner = newClient();
    await owner.auth.signUp({ email: `s-${unique()}@example.com`, password: "Sdk!pass-1234" });
    await assert.rejects(owner.storage.from("private").upload(`sdk/${unique()}.bin`, new Uint8Array(5000)));
  });

  test("buckets are listed", async () => {
    const buckets = await newClient().storage.listBuckets();
    assert.deepEqual(buckets.map((b) => b.name).sort(), ["private", "pub"]);
  });
});

describe("live: realtime", { skip: !live }, () => {
  test("two clients exchange messages, see presence, and read history", async () => {
    const a = newClient();
    const b = newClient();
    const name = `chat:${unique()}`;
    const received: string[] = [];
    const chanB = b.realtime.channel<{ text: string }, { name: string }>(name, { presence: { name: "Bob" } });
    chanB.on("message", (m) => received.push(m.payload.text));
    await chanB.subscribe();
    const chanA = a.realtime.channel<{ text: string }, { name: string }>(name, { presence: { name: "Ada" } });
    await chanA.subscribe();
    await until(() => chanA.presenceState().length === 2 && chanB.presenceState().length === 2, 4000);
    assert.deepEqual(chanA.presenceState().map((m) => m.meta.name).sort(), ["Ada", "Bob"]);

    await chanA.send("message", { text: "hello bob" });
    await until(() => received.length === 1, 4000);
    assert.deepEqual(received, ["hello bob"]);

    assert.deepEqual((await chanA.history(10)).map((m) => m.payload), [{ text: "hello bob" }]);
    // HTTP publish reaches socket subscribers; presence over HTTP lists both.
    await a.realtime.publish(name, "message", { text: "via http" });
    await until(() => received.length === 2, 4000);
    assert.equal((await a.realtime.presence(name)).length, 2);

    await chanB.unsubscribe();
    await until(() => chanA.presenceState().length === 1, 4000);
  });

  test("a channel whose rule denies subscription is refused with the server's reason", async () => {
    const client = newClient();
    await assert.rejects(client.realtime.channel("locked:vault").subscribe(), (e: unknown) => e instanceof RealtimeError && e.code === "forbidden");
  });

  test("a private user channel works for its owner only, and a reconnect resumes the subscription", async () => {
    const owner = newClient();
    const stranger = newClient();
    const signed = await owner.auth.signUp({ email: `rt-${unique()}@example.com`, password: "Sdk!pass-1234" });
    await stranger.auth.signUp({ email: `rt2-${unique()}@example.com`, password: "Sdk!pass-1234" });
    const channelName = `user:${signed.user.id}`;
    await assert.rejects(stranger.realtime.channel(channelName).subscribe(), RealtimeError);
    const mine = owner.realtime.channel<string>(channelName, { replay: 10 });
    const got: string[] = [];
    mine.on("message", (m) => got.push(m.payload));
    await mine.subscribe();
    await mine.send("note", "one");
    await until(() => got.length === 1, 4000);

    // Break the socket; the client reconnects, rejoins, and keeps receiving.
    // @ts-expect-error private
    owner.realtime.socket.close(4000, "test drop");
    await until(() => owner.realtime.status === "reconnecting", 3000);
    await until(() => owner.realtime.status === "open" && mine.subscribed, 6000);
    await mine.send("note", "two");
    await until(() => got.length === 2, 4000);
    assert.deepEqual(got, ["one", "two"], "no duplicate of the first message after replay");
  });
});
