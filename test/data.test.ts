import assert from "node:assert/strict";
import { after, test } from "node:test";
import { InvalidQueryError, NotFoundError, ValidationError, createClient } from "../src/index.js";
import { closeAll, serve, type Fake } from "./helpers.js";

after(closeAll);

interface Post {
  id: number;
  title: string;
  status: "draft" | "live";
  views: number;
  featured: boolean;
  org_id: string | null;
  created_at: string;
  author?: { id: number; name: string };
}
interface NewPost {
  title: string;
  status?: "draft" | "live";
}
type DB = { resources: { posts: { Row: Post; Insert: NewPost; Update: Partial<NewPost> } } };

const emptyPage = { data: [], page: 1, per_page: 20, total: 0 };

async function client(handler: Parameters<typeof serve>[0]) {
  const fake = await serve(handler);
  return { fake, db: createClient<DB>({ url: fake.url, apiKey: "pk", retry: false }) };
}

function sent(fake: Fake, index = -1): URLSearchParams {
  return fake.requests.at(index)!.query;
}

test("filters, sort, select, expand and paging serialise to the server's grammar", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  await db
    .from("posts")
    .eq("status", "live")
    .gte("views", 10)
    .like("title", "Hello*")
    .in("id", [1, 2, 3])
    .order("created_at", "desc")
    .order("title")
    .select("id", "title")
    .expand("author")
    .page(3)
    .perPage(50);
  const q = sent(fake);
  assert.equal(q.get("filter[status]"), "eq.live");
  assert.equal(q.get("filter[views]"), "gte.10");
  assert.equal(q.get("filter[title]"), "like.Hello*");
  assert.equal(q.get("filter[id]"), "in.1,2,3");
  assert.equal(q.get("sort"), "-created_at,title");
  assert.equal(q.get("select"), "id,title");
  assert.equal(q.get("expand"), "author");
  assert.equal(q.get("page"), "3");
  assert.equal(q.get("per_page"), "50");
  db.dispose();
});

test("a value that looks like an operator is still an equality", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  await db.from("posts").eq("title", "gt.5");
  assert.equal(sent(fake).get("filter[title]"), "eq.gt.5");
  db.dispose();
});

test("booleans and null go through is/isnot, because eq.false matches true rows on the server", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  await db.from("posts").eq("featured", false);
  assert.equal(sent(fake).get("filter[featured]"), "is.false");
  await db.from("posts").neq("featured", true);
  assert.equal(sent(fake).get("filter[featured]"), "isnot.true");
  await db.from("posts").eq("org_id", null);
  assert.equal(sent(fake).get("filter[org_id]"), "is.null");
  await db.from("posts").neq("org_id", null);
  assert.equal(sent(fake).get("filter[org_id]"), "isnot.null");
  await db.from("posts").is("featured", true);
  assert.equal(sent(fake).get("filter[featured]"), "is.true");
  db.dispose();
});

test("dates become ISO strings", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  await db.from("posts").gte("created_at", new Date("2026-01-02T03:04:05.000Z"));
  assert.equal(sent(fake).get("filter[created_at]"), "gte.2026-01-02T03:04:05.000Z");
  db.dispose();
});

test("two filters on one field are refused instead of silently dropping one", async () => {
  const { db } = await client(() => ({ body: emptyPage }));
  assert.throws(() => db.from("posts").gte("views", 2).lte("views", 4), InvalidQueryError);
  assert.throws(() => db.from("posts").where({ views: { gte: 1, lte: 2 } }), InvalidQueryError);
  db.dispose();
});

test("in() refuses values with commas, and an empty list matches nothing without a request", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  assert.throws(() => db.from("posts").in("title", ["a,b"]), InvalidQueryError);
  const none = await db.from("posts").in("id", []);
  assert.deepEqual(none, { data: [], page: 1, per_page: 20, total: 0 });
  assert.equal(fake.requests.length, 0);
  await db.from("posts").notIn("id", []);
  assert.equal(fake.requests.length, 1);
  assert.equal(sent(fake).get("filter[id]"), null, "an empty not-in is no filter");
  db.dispose();
});

test("where() takes plain values and single-operator objects", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  await db.from("posts").where({ status: "live", views: { gte: 10 }, org_id: null });
  const q = sent(fake);
  assert.equal(q.get("filter[status]"), "eq.live");
  assert.equal(q.get("filter[views]"), "gte.10");
  assert.equal(q.get("filter[org_id]"), "is.null");
  db.dispose();
});

test("builders are immutable, so a base query can be reused", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  const live = db.from("posts").eq("status", "live");
  await live.eq("featured", true);
  await live;
  assert.equal(sent(fake).get("filter[featured]"), null);
  db.dispose();
});

test("a resource name with a slash or space is encoded", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  await db.resource("odd name").list();
  assert.equal(fake.requests[0]!.path, "/rest/v1/odd%20name");
  db.dispose();
});

test("list() takes plain parameters", async () => {
  const { fake, db } = await client(() => ({ body: emptyPage }));
  await db.from("posts").list({ where: { status: "live" }, sort: "-created_at,title", select: ["id"], expand: ["author"], page: 2, perPage: 5 });
  const q = sent(fake);
  assert.equal(q.get("sort"), "-created_at,title");
  assert.equal(q.get("page"), "2");
  assert.equal(q.get("per_page"), "5");
  db.dispose();
});

test("first, single, count and exists use a page of one", async () => {
  const { fake, db } = await client((req) => {
    const none = req.query.get("filter[title]") === "eq.none";
    return { body: { data: none ? [] : [{ id: 7, title: "Hi" }], page: 1, per_page: 1, total: none ? 0 : 42 } };
  });
  assert.deepEqual(await db.from("posts").first(), { id: 7, title: "Hi" });
  assert.equal(await db.from("posts").eq("title", "none").first(), null);
  await assert.rejects(db.from("posts").eq("title", "none").single(), NotFoundError);
  assert.equal(await db.from("posts").count(), 42);
  assert.equal(await db.from("posts").eq("title", "none").exists(), false);
  assert.equal(sent(fake).get("per_page"), "1");
  db.dispose();
});

test("count() refuses when the server cannot count", async () => {
  const { db } = await client(() => ({ body: { data: [], page: 1, per_page: 1, total: null } }));
  await assert.rejects(db.from("posts").count(), InvalidQueryError);
  db.dispose();
});

test("all() walks pages by total", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `p${i}` }));
  const { fake, db } = await client((req) => {
    const page = Number(req.query.get("page") ?? 1);
    const perPage = Number(req.query.get("per_page"));
    return { body: { data: rows.slice((page - 1) * perPage, page * perPage), page, per_page: perPage, total: rows.length } };
  });
  const all = await db.from("posts").all({ pageSize: 2 });
  assert.equal(all.length, 5);
  assert.equal(fake.requests.length, 3);
  const limited = await db.from("posts").all({ pageSize: 2, maxRecords: 3 });
  assert.equal(limited.length, 3);
  const streamed: number[] = [];
  for await (const row of db.from("posts").perPage(2)) streamed.push(row.id);
  assert.deepEqual(streamed, [1, 2, 3, 4, 5]);
  db.dispose();
});

test("with an unknown total, iteration stops at an empty page, not a short one", async () => {
  // A per-row policy filters after the page is read: pages are short, and can be empty mid-way.
  const pages = [[{ id: 1 }], [{ id: 2 }, { id: 3 }], [], []];
  const { fake, db } = await client((req) => {
    const page = Number(req.query.get("page") ?? 1);
    return { body: { data: pages[page - 1] ?? [], page, per_page: 5, total: null } };
  });
  const all = await db.from("posts").all({ pageSize: 5 });
  assert.deepEqual(all.map((r) => r.id), [1, 2, 3]);
  assert.equal(fake.requests.length, 3, "stopped at the first empty page");
  const patient = await db.from("posts").all({ pageSize: 5, stopAfterEmptyPages: 2 });
  assert.equal(patient.length, 3);
  db.dispose();
});

test("get, create, update, replace and delete use the resource paths", async () => {
  const { fake, db } = await client((req) => {
    if (req.method === "DELETE") return { status: 204 };
    if (req.method === "POST") return { status: 201, body: { id: 9, title: req.json.title } };
    return { body: { id: 9, title: "x" } };
  });
  assert.equal((await db.from("posts").get(9, { expand: ["author"] })).id, 9);
  assert.equal(fake.requests[0]!.query.get("expand"), "author");
  assert.deepEqual(await db.from("posts").create({ title: "New" }), { id: 9, title: "New" });
  await db.from("posts").update(9, { status: "live" });
  await db.from("posts").replace(9, { title: "Whole" });
  assert.equal(await db.from("posts").delete(9), undefined);
  assert.deepEqual(
    fake.requests.map((r) => `${r.method} ${r.path}`),
    ["GET /rest/v1/posts/9", "POST /rest/v1/posts", "PATCH /rest/v1/posts/9", "PUT /rest/v1/posts/9", "DELETE /rest/v1/posts/9"],
  );
  db.dispose();
});

test("maybeGet turns a 404 into null but not other errors", async () => {
  const { db } = await client((req) => (req.path.endsWith("/1") ? { status: 404, body: "Not found" } : { status: 403, body: "policy 'own' refused" }));
  assert.equal(await db.from("posts").maybeGet(1), null);
  await assert.rejects(db.from("posts").maybeGet(2), (e: unknown) => (e as { policy: string }).policy === "own");
  db.dispose();
});

test("a 422 from create is a ValidationError by field", async () => {
  const { db } = await client(() => ({ status: 422, body: [{ type: "missing", loc: ["body", "title"], msg: "Field required", input: {} }] }));
  await assert.rejects(db.from("posts").create({} as NewPost), (e: unknown) => e instanceof ValidationError && e.fieldError("title") === "Field required");
  db.dispose();
});

test("ids with slashes are encoded", async () => {
  const { fake, db } = await client(() => ({ body: { id: "a/b" } }));
  await db.from("posts").get("a/b");
  assert.equal(fake.requests[0]!.path, "/rest/v1/posts/a%2Fb");
  db.dispose();
});

test("createMany reports partial failure and keeps order", async () => {
  const { db } = await client((req) => (req.json.title === "bad" ? { status: 422, body: [{ type: "x", loc: ["body", "title"], msg: "no" }] } : { status: 201, body: { id: 1, title: req.json.title } }));
  const result = await db.from("posts").createMany([{ title: "a" }, { title: "bad" }, { title: "c" }], { concurrency: 2 });
  assert.deepEqual(result.created.map((r) => (r as unknown as Post).title), ["a", "c"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.index, 1);
  db.dispose();
});

test("createMany with stopOnError starts no new request after a failure", async () => {
  const { fake, db } = await client(() => ({ status: 500, text: "boom" }));
  const result = await db.from("posts").createMany([{ title: "a" }, { title: "b" }, { title: "c" }], { concurrency: 1, stopOnError: true });
  assert.equal(fake.requests.length, 1);
  assert.equal(result.failed.length, 1);
  db.dispose();
});

test("routes call custom paths with query and body", async () => {
  const { fake, db } = await client(() => ({ body: { ok: true } }));
  assert.deepEqual(await db.routes.post("checkout/start", { cart: 1 }, { query: { coupon: "X", dry: true } }), { ok: true });
  const sentReq = fake.requests[0]!;
  assert.equal(sentReq.path, "/rest/v1/checkout/start");
  assert.equal(sentReq.query.get("coupon"), "X");
  assert.equal(sentReq.query.get("dry"), "true");
  assert.deepEqual(sentReq.json, { cart: 1 });
  db.dispose();
});

test("functions unwrap {data}; flows return the body as sent", async () => {
  const { fake, db } = await client((req) => (req.path.startsWith("/functions/") ? { body: { data: { total: 42 } } } : { body: { auth: { authenticated: true } } }));
  assert.deepEqual(await db.functions.invoke("price", { sku: "a" }), { total: 42 });
  assert.deepEqual(await db.flows.run("whoami"), { auth: { authenticated: true } });
  assert.equal(fake.requests[0]!.path, "/functions/v1/price");
  assert.equal(fake.requests[1]!.path, "/flows/v1/whoami");
  assert.equal(fake.requests[1]!.raw.length, 0, "no body is sent when there is no input");
  db.dispose();
});

test("a function failure keeps its code and details", async () => {
  const { db } = await client(() => ({ status: 502, body: { error: "upstream_failed", message: "payments said no", details: { attempt: 2 } } }));
  await assert.rejects(db.functions.invoke("charge"), (e: unknown) => (e as { code: string; details: unknown }).code === "upstream_failed");
  db.dispose();
});
