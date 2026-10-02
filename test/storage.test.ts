import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigError, NotFoundError, createClient } from "../src/index.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

test("upload sends a raw PUT with the content type and key encoding", async () => {
  const fake = await serve(() => ({ status: 201, body: { bucket: "avatars", key: "u 1/me.png", size: 3, content_type: "image/png", etag: "e" } }));
  const db = createClient({ url: fake.url, apiKey: "pk", retry: false });
  const stored = await db.storage.from("avatars").upload("/u 1/me.png", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  assert.equal(stored.size, 3);
  const sent = fake.requests[0]!;
  assert.equal(sent.method, "PUT");
  assert.equal(sent.path, "/storage/v1/object/avatars/u%201/me.png");
  assert.equal(sent.headers["content-type"], "image/png");
  assert.deepEqual([...sent.raw], [1, 2, 3]);
  db.dispose();
});

test("upload defaults: text for strings, octet-stream for bytes, explicit type wins", async () => {
  const fake = await serve(() => ({ status: 201, body: {} }));
  const db = createClient({ url: fake.url, apiKey: "pk", retry: false });
  const bucket = db.storage.from("docs");
  await bucket.upload("a.txt", "hello");
  await bucket.upload("b.bin", new Uint8Array([1]));
  await bucket.upload("c.pdf", new Uint8Array([1]), { contentType: "application/pdf" });
  assert.deepEqual(
    fake.requests.map((r) => r.headers["content-type"]),
    ["text/plain; charset=utf-8", "application/octet-stream", "application/pdf"],
  );
  db.dispose();
});

test("an upload can be retried after a network blip (it replaces the object); the body is replayed intact", async () => {
  let attempts = 0;
  const fake = await serve(() => {
    attempts += 1;
    return attempts === 1 ? { status: 503, body: "busy" } : { status: 201, body: { key: "k" } };
  });
  const db = createClient({ url: fake.url, apiKey: "pk", retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  await db.storage.from("b").upload("k", "payload");
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1]!.raw.toString(), "payload");
  db.dispose();
});

test("download returns a Blob, text and json; a missing file is a NotFoundError", async () => {
  const fake = await serve((req) => (req.path.endsWith("missing") ? { status: 404, body: "Not found" } : { text: '{"a":1}', headers: { "content-type": "application/json" } }));
  const db = createClient({ url: fake.url, apiKey: "pk", retry: false });
  const bucket = db.storage.from("docs");
  assert.equal(await (await bucket.download("x.json")).text(), '{"a":1}');
  assert.equal(await bucket.downloadText("x.json"), '{"a":1}');
  assert.deepEqual(await bucket.downloadJson("x.json"), { a: 1 });
  await assert.rejects(bucket.download("missing"), NotFoundError);
  assert.equal(fake.requests[0]!.headers["accept"], "*/*");
  db.dispose();
});

test("listAll follows cursors and yields every file", async () => {
  const fake = await serve((req) => {
    const cursor = req.query.get("cursor");
    return cursor
      ? { body: { files: [{ key: "c" }], prefixes: [], cursor: "" } }
      : { body: { files: [{ key: "a" }, { key: "b" }], prefixes: ["x/"], cursor: "next" } };
  });
  const db = createClient({ url: fake.url, apiKey: "pk" });
  const keys: string[] = [];
  for await (const file of db.storage.from("docs").listAll({ prefix: "p/", pageSize: 2 })) keys.push(file.key);
  assert.deepEqual(keys, ["a", "b", "c"]);
  assert.equal(fake.requests[0]!.query.get("prefix"), "p/");
  assert.equal(fake.requests[0]!.query.get("limit"), "2");
  assert.equal(fake.requests[1]!.query.get("cursor"), "next");
  db.dispose();
});

test("signed URLs: ask for one, then upload to it with no credentials", async () => {
  let signedBase = "";
  const fake = await serve((req) => {
    if (req.path.startsWith("/storage/v1/sign/")) return { body: { url: `${signedBase}/storage/v1/signed/acme/dev/docs/in.csv?token=T`, expires_at: 1, method: "PUT" } };
    if (req.path.startsWith("/storage/v1/signed/")) return { status: 201, body: { bucket: "docs", key: "in.csv", size: 2, content_type: "text/csv" } };
    return undefined;
  });
  signedBase = fake.url;
  const db = createClient({ url: fake.url, apiKey: "pk" });
  const bucket = db.storage.from("docs");
  const signed = await bucket.createSignedUploadUrl("in.csv", { expiresIn: 60, contentType: "text/csv", maxBytes: 1000 });
  assert.deepEqual(fake.requests[0]!.json, { method: "PUT", expires_in: 60, content_type: "text/csv", max_bytes: 1000 });
  await bucket.uploadToSignedUrl(signed.url, "a,b", { contentType: "text/csv" });
  const upload = fake.requests[1]!;
  assert.equal(upload.query.get("token"), "T");
  assert.equal(upload.headers["apikey"], undefined, "the URL is the credential");
  assert.equal(upload.headers["authorization"], undefined);
  db.dispose();
});

test("getPublicUrl embeds the publishable key and refuses a secret key", async () => {
  const fake = await serve(() => ({ body: {} }));
  const pk = createClient({ url: fake.url, apiKey: "pb_pk_live_1" });
  assert.equal(pk.storage.from("pub").getPublicUrl("a b/c.png"), `${fake.url}/storage/v1/object/pub/a%20b/c.png?apikey=pb_pk_live_1`);
  pk.dispose();
  const sk = createClient({ url: fake.url, apiKey: "pb_sk_live_1" });
  assert.throws(() => sk.storage.from("pub").getPublicUrl("c.png"), ConfigError);
  sk.dispose();
});

test("an empty key is refused before any request", async () => {
  const fake = await serve(() => ({ body: {} }));
  const db = createClient({ url: fake.url, apiKey: "pk" });
  await assert.rejects(async () => db.storage.from("b").remove("/"), ConfigError);
  assert.equal(fake.requests.length, 0);
  db.dispose();
});

test("client guards: no url, bad url, secret key in a browser", async () => {
  assert.throws(() => createClient({ url: "", apiKey: "pk" }), ConfigError);
  assert.throws(() => createClient({ url: "not a url", apiKey: "pk" }), ConfigError);
  assert.throws(() => createClient({ url: "ftp://x", apiKey: "pk" }), ConfigError);
  assert.throws(() => createClient({ url: "http://x", apiKey: "" }), ConfigError);
  const g = globalThis as Record<string, unknown>;
  g["window"] = {};
  g["document"] = {};
  try {
    assert.throws(() => createClient({ url: "http://x", apiKey: "pb_sk_live_x" }), /secret key/);
    const allowed = createClient({ url: "http://x", apiKey: "pb_sk_live_x", dangerouslyAllowBrowser: true, auth: { detectSessionInUrl: false, persistSession: false } });
    allowed.dispose();
  } finally {
    delete g["window"];
    delete g["document"];
  }
});
