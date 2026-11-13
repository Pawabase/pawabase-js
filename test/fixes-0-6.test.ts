import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigError, createClient } from "../src/index.js";
import { admin } from "../src/admin.js";
import { manage } from "../src/manage/index.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

test("fileUrl is the keyless gateway address, with image options", () => {
  const db = createClient({ url: "https://api.example.com", apiKey: "pb_pk_x", environment: "acme-prod", retry: false });
  assert.equal(db.storage.from("avatars").fileUrl("u 1/me.png"), "https://api.example.com/storage/v1/files/acme-prod/avatars/u%201/me.png");
  const url = new URL(db.storage.from("avatars").fileUrl("me.png", { width: 96, fit: "cover", format: "auto" }));
  assert.equal(url.searchParams.get("width"), "96");
  assert.equal(url.searchParams.get("fit"), "cover");
  assert.throws(() => createClient({ url: "https://x", apiKey: "pk" }).storage.from("a").fileUrl("k"), ConfigError);
  db.dispose();
});

test("share links need a secret key and go to the bucket's shares", async () => {
  const fake = await serve(() => ({ status: 201, body: { id: "s1", url: "https://x/storage/v1/share/pbs_1" } }));
  const server = createClient({ url: fake.url, apiKey: "pb_sk_secret", environment: "acme-prod", retry: false });
  const share = await server.storage.from("contracts").createShareLink("acme/msa.pdf", { expiresIn: 600, permissions: "download" });
  assert.equal(share.id, "s1");
  const sent = fake.requests[0]!;
  assert.equal(sent.path, "/platform/v1/envs/acme-prod/buckets/contracts/shares");
  assert.deepEqual(sent.json, { key: "acme/msa.pdf", expires_in: 600, permissions: "download", label: "" });
  const browser = createClient({ url: fake.url, apiKey: "pb_pk_public", environment: "acme-prod", retry: false });
  assert.throws(() => browser.storage.from("contracts").createShareLink("k"), ConfigError);
  server.dispose();
  browser.dispose();
});

test("similar() sends where conditions as list filters", async () => {
  const fake = await serve(() => ({ body: { data: [], metric: "cosine", count: 0 } }));
  const db = createClient({ url: fake.url, apiKey: "pk", retry: false });
  await db.from("notes").similar({ text: "refunds", where: { kind: "public", archived: false, rank: { gte: 2 } } });
  const sent = fake.requests[0]!;
  assert.equal(sent.query.get("filter[kind]"), "eq.public");
  assert.equal(sent.query.get("filter[archived]"), "is.false");
  assert.equal(sent.query.get("filter[rank]"), "gte.2");
  const none = await db.from("notes").similar({ text: "x", where: { id: { in: [] } } });
  assert.equal(none.count, 0);
  assert.equal(fake.requests.length, 1);   // an empty in-list is answered without a request
  db.dispose();
});

test("rememberDevice and acceptedTerms reach the server", async () => {
  const fake = await serve((request) =>
    request.json?.grant_type === "password"
      ? { body: { mfa_required: true, mfa_token: "m1", factors: ["totp"] } }
      : request.json?.grant_type === "mfa"
        ? { body: { access_token: "a", refresh_token: "r", expires_in: 900, user: { id: "u" } } }
        : { status: 201, body: { user: { id: "u" }, verification_required: true } },
  );
  const db = createClient({ url: fake.url, apiKey: "pk", retry: false, auth: { persistSession: false } });
  const result = await db.auth.signInWithPassword({ email: "a@b.c", password: "p", rememberDevice: true });
  assert.equal(result.status, "mfa_required");
  if (result.status === "mfa_required") await result.verify("123456");
  await db.auth.signUp({ email: "n@b.c", password: "p", acceptedTerms: true });
  assert.equal(fake.requests[0]!.json.remember_device, true);
  assert.equal(fake.requests[1]!.json.remember_device, true);
  assert.equal(fake.requests[2]!.json.accepted_terms, true);
  db.dispose();
});

test("admin orgs.update sends app_metadata, seats, MFA and suspension", async () => {
  const fake = await serve(() => ({ body: {} }));
  const a = admin(createClient({ url: fake.url, apiKey: "pb_sk_s", environment: "acme-prod", retry: false }));
  await a.orgs.update("acme", { appMetadata: { plan: "pro" }, maxMembers: null, requireMfa: true, suspended: false });
  const sent = fake.requests[0]!;
  assert.equal(sent.method, "PATCH");
  assert.deepEqual(sent.json, { app_metadata: { plan: "pro" }, max_members: null, require_mfa: true, suspended: false });
});

test("manage mail: send, retry, cancel, stats", async () => {
  const fake = await serve(() => ({ body: {} }));
  const m = manage(createClient({ url: fake.url, apiKey: "pb_sk_s", environment: "acme-prod", retry: false }));
  await m.mail.send({ to: ["ada@example.com"], template: "welcome", data: { name: "Ada" }, scheduledAt: new Date("2026-12-01T09:00:00Z") });
  await m.mail.retry(7);
  await m.mail.cancel("8");
  await m.mail.stats({ days: 7 });
  const [send, retry, cancel, stats] = fake.requests;
  assert.equal(send!.path, "/platform/v1/envs/acme-prod/mail/send");
  assert.equal(send!.json.scheduled_at, "2026-12-01T09:00:00.000Z");
  assert.deepEqual(send!.json.to, ["ada@example.com"]);
  assert.equal(retry!.path, "/platform/v1/envs/acme-prod/mail/log/7/retry");
  assert.equal(cancel!.path, "/platform/v1/envs/acme-prod/mail/log/8/cancel");
  assert.equal(stats!.query.get("days"), "7");
});
