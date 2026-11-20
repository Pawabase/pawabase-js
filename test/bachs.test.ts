import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ApiError, TimeoutError, createClient } from "../src/index.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

const base = { apiKey: "pk_test", project: "P1", retry: false as const };
const started = { payment_id: "01J", reference: "bp_abc", status: "pending", checkout_url: "https://checkout.bachs.io/c1", expires_at: "2099-01-01T00:00:00Z" };
const row = (status: string) => ({ payment: { id: "01J", reference: "bp_abc", amount: "5000.00", currency: "NGN", status } });

test("create posts the payment with an Idempotency-Key and answers in camelCase", async () => {
  const fake = await serve(() => ({ status: 201, body: started }));
  const pb = createClient({ url: fake.url, ...base });
  const made = await pb.bachs.payments.create({ amount: 5000, currency: "NGN", successUrl: "https://shop.example.com/ok", metadata: { orderId: "7" } });
  assert.equal(made.checkoutUrl, "https://checkout.bachs.io/c1");
  assert.equal(made.reference, "bp_abc");
  assert.equal(made.replayed, false);
  const sent = fake.requests[0]!;
  assert.equal(sent.method, "POST");
  assert.equal(sent.path, "/rest/v1/bachs/payments");
  assert.deepEqual(sent.json, { amount: "5000", currency: "NGN", success_url: "https://shop.example.com/ok", metadata: { orderId: "7" } });
  assert.ok(String(sent.headers["idempotency-key"]).length > 8);
});

test("a given idempotency key is sent as it is, and a replay says so", async () => {
  const fake = await serve(() => ({ status: 200, body: started, headers: { "idempotent-replayed": "true" } }));
  const pb = createClient({ url: fake.url, ...base });
  const again = await pb.bachs.payments.create({ amount: "1.00", currency: "NGN", successUrl: "https://x.example/ok", idempotencyKey: "order-7" });
  assert.equal(fake.requests[0]!.headers["idempotency-key"], "order-7");
  assert.equal(again.replayed, true);
});

test("create retries a dropped gateway answer with the same key, so no second payment starts", async () => {
  const fake = await serve((_r, i) => (i === 0 ? { status: 503, body: { error: "unavailable" } } : { status: 201, body: started }));
  const pb = createClient({ url: fake.url, apiKey: "pk_test", project: "P1", retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 2 } });
  const made = await pb.bachs.payments.create({ amount: "9.00", currency: "NGN", successUrl: "https://x.example/ok" });
  assert.equal(made.reference, "bp_abc");
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[0]!.headers["idempotency-key"], fake.requests[1]!.headers["idempotency-key"]);
});

test("a refusal from the server comes through as an ApiError", async () => {
  const fake = await serve(() => ({ status: 422, body: { error: "currency_not_accepted", message: "That currency is not accepted." } }));
  const pb = createClient({ url: fake.url, ...base });
  await assert.rejects(() => pb.bachs.payments.create({ amount: "1", currency: "XXX", successUrl: "https://x.example/ok" }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "currency_not_accepted");
    return true;
  });
});

test("get reads one payment by reference", async () => {
  const fake = await serve(() => ({ body: row("paid") }));
  const pb = createClient({ url: fake.url, ...base });
  const payment = await pb.bachs.payments.get("bp_abc");
  assert.equal(payment.status, "paid");
  assert.equal(fake.requests[0]!.path, "/rest/v1/bachs/payments/bp_abc");
});

test("waitFor keeps asking until the payment is no longer pending", async () => {
  const fake = await serve((_r, i) => ({ body: row(i < 2 ? "pending" : "paid") }));
  const pb = createClient({ url: fake.url, ...base });
  const payment = await pb.bachs.payments.waitFor("bp_abc", { intervalMs: 5 });
  assert.equal(payment.status, "paid");
  assert.equal(fake.requests.length, 3);
});

test("waitFor can stop at chosen statuses, and times out while still pending", async () => {
  const fake = await serve(() => ({ body: row("pending") }));
  const pb = createClient({ url: fake.url, ...base });
  await assert.rejects(() => pb.bachs.payments.waitFor("bp_abc", { intervalMs: 5, timeoutMs: 30 }), TimeoutError);
  const done = await serve(() => ({ body: row("expired") }));
  const other = createClient({ url: done.url, ...base });
  assert.equal((await other.bachs.payments.waitFor("bp_abc", { until: ["paid", "expired"] })).status, "expired");
});

test("list filters by status, newest first", async () => {
  const fake = await serve(() => ({ body: { data: [{ reference: "bp_1", status: "paid" }], page: 1, per_page: 20, total: 1 } }));
  const pb = createClient({ url: fake.url, ...base });
  const page = await pb.bachs.payments.list({ status: "paid" });
  assert.equal(page.data.length, 1);
  assert.equal(fake.requests[0]!.path, "/rest/v1/bachs_payments");
  assert.equal(fake.requests[0]!.query.get("filter[status]"), "eq.paid");
  assert.equal(fake.requests[0]!.query.get("sort"), "-created_at");
});
