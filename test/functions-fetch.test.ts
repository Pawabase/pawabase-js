import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createClient } from "../src/index.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

test("functions.fetch reaches an HTTP function's path with any method and returns its Response, errors included", async () => {
  const fake = await serve((req) =>
    req.path.endsWith("/missing") ? { status: 404, body: { error: "not_found" } } : { status: 201, body: { ok: true }, headers: { "x-fn": "1" } },
  );
  const client = createClient({ url: fake.url, apiKey: "pb_pk_test", retry: false });
  const res = await client.functions.fetch("orders", "/42/items", { method: "PUT", body: { sku: "A1" }, query: { q: "x" }, branch: "feat" });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-fn"), "1");
  assert.deepEqual(await res.json(), { ok: true });
  const sent = fake.requests[0]!;
  assert.equal(sent.method, "PUT");
  assert.equal(sent.path, "/functions/v1/orders/42/items");
  assert.equal(sent.query.get("q"), "x");
  assert.equal(sent.headers["x-pawabase-branch"], "feat");
  assert.deepEqual(sent.json, { sku: "A1" });
  const missing = await client.functions.fetch("orders", "missing");
  assert.equal(missing.status, 404);
  assert.equal(fake.requests[1]!.method, "GET");
  client.dispose();
});
