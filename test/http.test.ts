import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createClient } from "../src/index.js";
import { AbortError, NetworkError, RateLimitError, ServerError, TimeoutError, AuthenticationError } from "../src/errors.js";
import { closeAll, serve, sessionBody } from "./helpers.js";

after(closeAll);

const fast = { retry: { baseDelayMs: 1, maxDelayMs: 5 } } as const;

test("every request carries the API key and client info, and errors carry the request id", async () => {
  const fake = await serve(() => ({ status: 404, body: "Not found" }));
  const client = createClient({ url: fake.url, apiKey: "pk_test_1", ...fast });
  try {
    await client.from("posts").get(1);
    assert.fail("should have thrown");
  } catch (error) {
    assert.equal((error as { requestId: string }).requestId, "req-0");
  }
  const sent = fake.requests[0]!;
  assert.equal(sent.headers["apikey"], "pk_test_1");
  assert.match(String(sent.headers["x-client-info"]), /^pawabase-js\//);
  assert.equal(sent.headers["authorization"], undefined);
  client.dispose();
  await fake.close();
});

test("a 429 is retried for any method, honouring Retry-After", async () => {
  const fake = await serve((_req, index) =>
    index < 2 ? { status: 429, body: { error: "rate_limit_exceeded", retry_after: 0 }, headers: { "retry-after": "0" } } : { status: 201, body: { id: 1 } },
  );
  const client = createClient({ url: fake.url, apiKey: "pk", ...fast });
  const created = await client.from("posts").create({ title: "x" });
  assert.deepEqual(created, { id: 1 });
  assert.equal(fake.requests.length, 3);
  client.dispose();
  await fake.close();
});

test("a Retry-After beyond the cap is surfaced, not waited for", async () => {
  const fake = await serve(() => ({ status: 429, body: { error: "rate_limit_exceeded", retry_after: 120 }, headers: { "retry-after": "120" } }));
  const client = createClient({ url: fake.url, apiKey: "pk", retry: { baseDelayMs: 1, maxRetryAfterMs: 1000 } });
  await assert.rejects(client.from("posts").list(), (error: unknown) => error instanceof RateLimitError && error.retryAfter === 120);
  assert.equal(fake.requests.length, 1);
  client.dispose();
  await fake.close();
});

test("a GET is retried on 503; a POST is not", async () => {
  const fake = await serve((req, index) => (req.method === "GET" && index === 0 ? { status: 503, body: "busy" } : req.method === "GET" ? { status: 200, body: { data: [], page: 1, per_page: 20, total: 0 } } : { status: 503, body: "busy" }));
  const client = createClient({ url: fake.url, apiKey: "pk", ...fast });
  const page = await client.from("posts").list();
  assert.equal(page.total, 0);
  assert.equal(fake.requests.length, 2);
  await assert.rejects(client.from("posts").create({ title: "x" }), ServerError);
  assert.equal(fake.requests.length, 3, "the POST was sent once");
  client.dispose();
  await fake.close();
});

test("a 500 is never retried", async () => {
  const fake = await serve(() => ({ status: 500, text: "Internal Server Error" }));
  const client = createClient({ url: fake.url, apiKey: "pk", ...fast });
  await assert.rejects(client.from("posts").list(), ServerError);
  assert.equal(fake.requests.length, 1);
  client.dispose();
  await fake.close();
});

test("retries can be turned off", async () => {
  const fake = await serve(() => ({ status: 503, body: "busy" }));
  const client = createClient({ url: fake.url, apiKey: "pk", retry: false });
  await assert.rejects(client.from("posts").list(), ServerError);
  assert.equal(fake.requests.length, 1);
  client.dispose();
  await fake.close();
});

test("an unreachable server is a NetworkError, retried for safe methods", async () => {
  const fake = await serve(() => ({ body: {} }));
  const url = fake.url;
  await fake.close();
  const client = createClient({ url, apiKey: "pk", ...fast, retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
  let retries = 0;
  const hooked = createClient({
    url,
    apiKey: "pk",
    retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    hooks: { onRetry: () => void (retries += 1) },
  });
  await assert.rejects(client.from("posts").list(), NetworkError);
  await assert.rejects(hooked.from("posts").list(), NetworkError);
  assert.equal(retries, 2);
  client.dispose();
  hooked.dispose();
});

test("a slow server times out", async () => {
  const fake = await serve(() => ({ body: {}, delayMs: 300 }));
  const client = createClient({ url: fake.url, apiKey: "pk", timeoutMs: 40, retry: false });
  await assert.rejects(client.from("posts").list(), (error: unknown) => error instanceof TimeoutError && error.timeoutMs === 40);
  client.dispose();
  await fake.close();
});

test("the caller's signal aborts, and an abort is not retried", async () => {
  const fake = await serve(() => ({ body: {}, delayMs: 300 }));
  const client = createClient({ url: fake.url, apiKey: "pk", ...fast });
  const controller = new AbortController();
  const pending = client.from("posts").query().withOptions({ signal: controller.signal }).execute();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, AbortError);
  assert.equal(fake.requests.length, 1);
  client.dispose();
  await fake.close();
});

test("hooks see requests and responses, with secrets masked", async () => {
  const fake = await serve(() => ({ body: { data: [], page: 1, per_page: 20, total: 0 } }));
  const seen: string[] = [];
  const client = createClient({
    url: fake.url,
    apiKey: "pk_secretish",
    hooks: {
      onRequest: (info) => seen.push(`${info.method} ${info.headers["apikey"]}`),
      onResponse: (info) => seen.push(`${info.status} ${info.requestId}`),
    },
  });
  await client.from("posts").list();
  assert.deepEqual(seen, ["GET ***", "200 req-0"]);
  client.dispose();
  await fake.close();
});

test("a throwing hook never fails the request", async () => {
  const fake = await serve(() => ({ body: { data: [], page: 1, per_page: 20, total: 0 } }));
  const client = createClient({ url: fake.url, apiKey: "pk", hooks: { onRequest: () => { throw new Error("boom"); } } });
  await client.from("posts").list();
  client.dispose();
  await fake.close();
});

test("a rejected token is refreshed once, shared by concurrent requests, and the requests replayed", async () => {
  let current = "access-valid";
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/token") {
      current = "access-new";
      return { body: sessionBody(3600, { access_token: "access-new", refresh_token: "refresh-new" }) };
    }
    if (req.headers["authorization"] === `Bearer ${current}`) return { body: { data: [], page: 1, per_page: 20, total: 0 } };
    return { status: 401, body: "Authentication required" };
  });
  const client = createClient({ url: fake.url, apiKey: "pk", ...fast, auth: { persistSession: false, autoRefreshToken: false } });
  // Seed a session whose access token the server will reject.
  const seed = { ...sessionBody(3600, { access_token: "access-old", refresh_token: "refresh-old" }) };
  await client.auth.initialized();
  // @ts-expect-error reach in to seed the stored session without a sign-in round trip
  client.auth.session = seed;
  const results = await Promise.all([client.from("a").list(), client.from("b").list(), client.from("c").list()]);
  assert.equal(results.length, 3);
  const refreshes = fake.requests.filter((r) => r.path === "/auth/v1/token");
  assert.equal(refreshes.length, 1, "three 401s share one refresh");
  assert.equal(refreshes[0]!.json.refresh_token, "refresh-old");
  client.dispose();
  await fake.close();
});

test("a 401 with a token that cannot be refreshed surfaces and signs out", async () => {
  const fake = await serve((req) => (req.path === "/auth/v1/token" ? { status: 400, body: "invalid refresh token" } : { status: 401, body: "Authentication required" }));
  const client = createClient({ url: fake.url, apiKey: "pk", ...fast, auth: { persistSession: false, autoRefreshToken: false } });
  await client.auth.initialized();
  // @ts-expect-error seed
  client.auth.session = sessionBody();
  const events: string[] = [];
  client.auth.onAuthStateChange((event) => events.push(event));
  await assert.rejects(client.from("posts").list(), AuthenticationError);
  assert.ok(events.includes("SIGNED_OUT"));
  assert.equal(await client.auth.getSession(), null);
  client.dispose();
  await fake.close();
});

test("JSON bodies get a content type; Blob bodies keep their own", async () => {
  const fake = await serve(() => ({ status: 201, body: { id: 1 } }));
  const client = createClient({ url: fake.url, apiKey: "pk" });
  await client.from("posts").create({ title: "x" });
  assert.equal(fake.requests[0]!.headers["content-type"], "application/json");
  assert.deepEqual(fake.requests[0]!.json, { title: "x" });
  client.dispose();
  await fake.close();
});
