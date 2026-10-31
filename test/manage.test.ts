import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigError, createClient } from "../src/index.js";
import { admin } from "../src/admin.js";
import { manage } from "../src/manage/index.js";
import { closeAll, serve } from "./helpers.js";

const clients: Array<{ dispose(): void }> = [];
after(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await closeAll();
});

const BASE = "/platform/v1/envs/production";

async function secret() {
  const fake = await serve(() => ({ status: 200, body: { data: [] } }));
  const client = createClient({ url: fake.url, apiKey: "pb_sk_test", environment: "production", retry: false });
  clients.push(client);
  return { fake, client, m: manage(client), last: () => fake.requests[fake.requests.length - 1]! };
}

test("the management plane needs a secret key and an environment", async () => {
  const fake = await serve(() => ({ body: {} }));
  const publishable = createClient({ url: fake.url, apiKey: "pb_pk_test" });
  clients.push(publishable);
  assert.throws(() => manage(publishable), ConfigError);
  assert.throws(() => admin(publishable), ConfigError);
  const { m } = await secret();
  assert.equal(m.flows.environment, "production");
  assert.equal(m.withEnvironment("staging").flows.environment, "staging");
});

test("definitions use names, branches and encoded paths", async () => {
  const { m, last } = await secret();
  await m.flows.list({ branch: "feat" });
  assert.equal(last().path, `${BASE}/flows`);
  assert.equal(last().query.get("branch"), "feat");
  await m.flows.replace("a b", { name: "a b" });
  assert.equal(last().method, "PUT");
  assert.equal(last().path, `${BASE}/flows/a%20b`);
  await m.withEnvironment("staging").policies.remove("p");
  assert.equal(last().method, "DELETE");
  assert.equal(last().path, "/platform/v1/envs/staging/policies/p");
});

test("keys, secrets and the firewall send the bodies the server reads", async () => {
  const { m, last } = await secret();
  await m.keys.create("ci", { role: "secret", scopes: ["functions:invoke"], allowedIps: ["10.0.0.0/8"] });
  assert.deepEqual(last().json, { name: "ci", role: "secret", scopes: ["functions:invoke"], allowed_ips: ["10.0.0.0/8"], allowed_routes: [] });
  await m.keys.rotate("k1", { graceHours: 2 });
  assert.equal(last().path, `${BASE}/keys/k1/rotate`);
  assert.deepEqual(last().json, { grace_hours: 2 });
  await m.secrets.set("STRIPE_KEY", "v", { rotateEveryDays: 30 });
  assert.equal(last().method, "PUT");
  assert.deepEqual(last().json, { value: "v", description: "", rotate_every_days: 30 });
  await m.firewall.addRule({ name: "Burst", action: "rate_limit", conditions: [{ field: "path", op: "starts_with", value: "/auth" }], rateLimit: { requests: 5, window_seconds: 60 } });
  assert.equal(last().path, `${BASE}/firewall`);
  assert.equal(last().json.action, "rate_limit");
  assert.equal(last().json.logic, "all");
  assert.equal(last().json.rate_limit.requests, 5);
  await m.firewall.order(["a", "b"]);
  assert.equal(last().method, "PUT");
  assert.deepEqual(last().json, { ids: ["a", "b"] });
  await m.firewall.bans({ includeExpired: true });
  assert.equal(last().query.get("all"), "1");
});

test("jobs, cache and observability match the server's models", async () => {
  const { m, last } = await secret();
  await m.jobs.replay({ job: "send_mail", sinceMinutes: 30, dryRun: true });
  assert.deepEqual(last().json, { ids: [], status: "failed", job: "send_mail", since_minutes: 30, limit: 200, dry_run: true });
  await m.cache.invalidate({ tags: ["resource:posts"] });
  assert.deepEqual(last().json, { tags: ["resource:posts"], resources: [] });
  await m.observability.logs({ q: "timeout", minutes: 15 });
  assert.equal(last().path, `${BASE}/logs`);
  assert.equal(last().query.get("q"), "timeout");
  assert.equal(last().query.get("limit"), "200");
  await m.observability.metricSeries("errors", { comparePrevious: true });
  assert.equal(last().query.get("compare"), "previous");
  await m.alarms.history();
  assert.equal(last().path, `${BASE}/alarm-events`);
  await m.health.audit({ actor: "ada" });
  assert.equal(last().path, "/platform/v1/audit");
  assert.equal(last().query.get("actor"), "ada");
});

test("lifecycle calls are project-wide or environment-scoped", async () => {
  const { m, last } = await secret();
  await m.environments.list();
  assert.equal(last().path, "/platform/v1/envs");
  await m.environments.update("staging", { settings: { a: 1 } });
  assert.equal(last().method, "PATCH");
  assert.equal(last().path, "/platform/v1/envs/staging");
  assert.deepEqual(last().json, { settings: { a: 1 } });
  await m.environments.promote("staging", { include: ["flows"] });
  assert.deepEqual(last().json, { to: "staging", include: ["flows"] });
  await m.backups.restoreSnapshot("s1", { strategy: "replace", confirm: "production" });
  assert.equal(last().path, `${BASE}/snapshots/s1/restore`);
  assert.equal(last().json.confirm, "production");
  assert.equal(last().json.safety_snapshot, true);
  await m.releases.merge("feat");
  assert.deepEqual(last().json, { target: "main", force: false });
});

test("user administration is scoped to the environment", async () => {
  const { client, fake } = await secret();
  const a = admin(client);
  const last = () => fake.requests[fake.requests.length - 1]!;
  await a.users.update("u1", { disabled: true });
  assert.equal(last().method, "PATCH");
  assert.equal(last().path, `${BASE}/auth/users/u1`);
  assert.deepEqual(last().json, { disabled: true });
  await a.users.create({ email: "a@b.io", password: "pw", roles: ["editor"] });
  assert.deepEqual(last().json.roles, ["editor"]);
  assert.equal(last().json.email_verified, true);
  await a.users.revoke("u1", ["posts:write"]);
  assert.equal(last().method, "DELETE");
  assert.deepEqual(last().json, { permissions: ["posts:write"] });
  await a.roles.define("editor", ["posts:*"]);
  assert.equal(last().method, "PUT");
  assert.equal(last().path, `${BASE}/auth/roles`);
  await a.orgs.addMember("acme", { email: "a@b.io", role: "admin" });
  assert.equal(last().path, `${BASE}/auth/orgs/acme/members`);
  await a.withEnvironment("staging").users.search({ status: "locked" });
  assert.equal(last().path, "/platform/v1/envs/staging/auth/users");
  assert.equal(last().query.get("status"), "locked");
});

test("realtime channel rules", async () => {
  const { m, last } = await secret();
  await m.realtimeChannels.list();
  assert.equal(last().path, `${BASE}/realtime-channels`);
  await m.realtimeChannels.create("chat:*", { kind: "presence", publish: "signed_in", history: 100, messageSizeLimit: 4096 });
  assert.equal(last().method, "POST");
  assert.deepEqual(last().json, { pattern: "chat:*", kind: "presence", publish: "signed_in", history: 100, message_size_limit: 4096 });
  await m.realtimeChannels.update("c1", { history: 10, presence: false });
  assert.equal(last().method, "PATCH");
  assert.equal(last().path, `${BASE}/realtime-channels/c1`);
  assert.deepEqual(last().json, { history: 10, presence: false });
  await m.realtimeChannels.remove("c1");
  assert.equal(last().method, "DELETE");
});

test("dashboards", async () => {
  const { m, last } = await secret();
  await m.dashboards.create("sales", { definition: { pages: [{ title: "Sales" }] }, title: "Sales" });
  assert.equal(last().path, `${BASE}/dashboards`);
  assert.deepEqual(last().json, { name: "sales", title: "Sales", description: "", definition: { pages: [{ title: "Sales" }] }, enabled: true });
  await m.dashboards.update("d1", { enabled: false });
  assert.equal(last().method, "PATCH");
  assert.deepEqual(last().json, { enabled: false });
  await m.dashboards.publish("d1", { public: true, publishableKey: "pb_pk_12345678" });
  assert.equal(last().method, "PUT");
  assert.equal(last().path, `${BASE}/dashboards/d1/publish`);
  assert.deepEqual(last().json, { public: true, publishable_key: "pb_pk_12345678" });
  await m.dashboards.publish("d1", { public: false });
  assert.deepEqual(last().json, { public: false });
  await m.dashboards.getOne("d1");
  await m.dashboards.remove("d1");
  assert.equal(last().method, "DELETE");
});

test("key scopes and token profile previews", async () => {
  const { client, m, last } = await secret();
  await m.keys.scopes();
  assert.equal(last().path, "/platform/v1/key-scopes");
  await admin(client).insight.previewTokenProfile({ name: "billing" }, "u1", { org: "acme" });
  assert.equal(last().method, "POST");
  assert.equal(last().path, `${BASE}/auth/token-profiles/preview`);
  assert.deepEqual(last().json, { profile: { name: "billing" }, user_id: "u1", org: "acme" });
});

test("activity, the timeline and privacy requests", async () => {
  const { client, fake } = await secret();
  const a = admin(client);
  const last = () => fake.requests[fake.requests.length - 1]!;
  await a.users.activity("u1", { weeks: 10 });
  assert.equal(last().method, "GET");
  assert.equal(last().path, `${BASE}/auth/users/u1/activity`);
  assert.match(last().url ?? last().path, /weeks=10|activity/);
  await a.users.timeline("u1", { type: "account", before: "2026-10-30T10:00:00+00:00" });
  assert.equal(last().path, `${BASE}/auth/users/u1/timeline`);
  await a.users.exportData("u1");
  assert.equal(last().method, "POST");
  assert.equal(last().path, `${BASE}/auth/users/u1/privacy/export`);
  await a.users.eraseData("u1", "a@b.io");
  assert.equal(last().path, `${BASE}/auth/users/u1/privacy/erase`);
  assert.deepEqual(last().json, { confirm: "a@b.io" });
  await a.privacy.requests({ limit: 5 });
  assert.equal(last().method, "GET");
  assert.equal(last().path, `${BASE}/auth/privacy/requests`);
  assert.equal(a.withEnvironment("staging").privacy.environment, "staging");
});

test("machine administration creates machines and keys under the environment", async () => {
  const { client, fake } = await secret();
  const a = admin(client);
  const last = () => fake.requests[fake.requests.length - 1]!;
  await a.machines.create({ name: "report-bot", kind: "agent", roles: ["reader"], appMetadata: { team: "ops" } });
  assert.equal(last().method, "POST");
  assert.equal(last().path, `${BASE}/auth/machines`);
  assert.deepEqual(last().json, { name: "report-bot", kind: "agent", roles: ["reader"], app_metadata: { team: "ops" } });
  await a.machines.disable("m1");
  assert.equal(last().method, "PATCH");
  assert.equal(last().path, `${BASE}/auth/machines/m1`);
  assert.deepEqual(last().json, { disabled: true });
  await a.machines.createKey("m1", { name: "prod", scopes: ["orders:*"], expiresInDays: 30 });
  assert.equal(last().path, `${BASE}/auth/machines/m1/keys`);
  assert.deepEqual(last().json, { name: "prod", scopes: ["orders:*"], expires_in_days: 30 });
  await a.machines.revokeKey("m1", "k1");
  assert.equal(last().method, "DELETE");
  assert.equal(last().path, `${BASE}/auth/machines/m1/keys/k1`);
});
