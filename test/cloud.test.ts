import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CloudError, OAuthError, PawabaseCloud, PawabaseOAuth, pkceChallenge } from "../src/cloud.js";

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fake(answer: (seen: Seen, i: number) => Response) {
  const calls: Seen[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const seen: Seen = { url, method: String(init.method ?? "GET"), headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: String(init.body ?? "") };
    calls.push(seen);
    return answer(seen, calls.length - 1);
  };
  return { fetch, calls };
}

const app = { clientId: "pbc_abc", clientSecret: "pbs_secret", redirectUri: "https://app.example.com/cb" };
const tokenReply = { access_token: "at1", refresh_token: "pbr_1", expires_in: 3600, scope: "projects:read projects:write", organization: "acme" };

test("authorize makes a PKCE S256 address with a state, and the challenge matches the verifier", async () => {
  const oauth = new PawabaseOAuth(app);
  const { url, state, codeVerifier } = await oauth.authorize({ scopes: ["projects:read", "projects:write"] });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, "https://dashboard.pawabase.com/oauth/authorize");
  assert.equal(q.get("client_id"), "pbc_abc");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("scope"), "projects:read projects:write");
  assert.equal(q.get("state"), state);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("code_challenge"), createHash("sha256").update(codeVerifier).digest("base64url"));
  assert.equal(await pkceChallenge(codeVerifier), q.get("code_challenge"));
  assert.ok(codeVerifier.length >= 43 && /^[A-Za-z0-9_-]+$/.test(codeVerifier));
});

test("callback refuses a return it did not start, a declined one, and a missing code", async () => {
  const oauth = new PawabaseOAuth(app);
  const saved = { state: "s1", codeVerifier: "v" };
  await assert.rejects(oauth.callback("https://app.example.com/cb?code=c&state=other", saved), (e: OAuthError) => e.code === "invalid_state");
  await assert.rejects(oauth.callback("https://app.example.com/cb?error=access_denied&error_description=The+person+declined.&state=s1", saved), (e: OAuthError) => e.code === "access_denied" && /declined/.test(e.message));
  await assert.rejects(oauth.callback("https://app.example.com/cb?state=s1", saved), (e: OAuthError) => e.code === "invalid_request");
});

test("callback trades the code with Basic auth, the verifier and the redirect, and answers tokens", async () => {
  const f = fake(() => json(tokenReply));
  const oauth = new PawabaseOAuth({ ...app, fetch: f.fetch });
  const tokens = await oauth.callback(new URLSearchParams({ code: "pbo_1", state: "s1" }), { state: "s1", codeVerifier: "verifier" });
  const sent = f.calls[0]!;
  assert.equal(sent.url, "https://dashboard.pawabase.com/oauth/token");
  assert.equal(sent.headers.authorization, `Basic ${Buffer.from("pbc_abc:pbs_secret").toString("base64")}`);
  const form = new URLSearchParams(sent.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "pbo_1");
  assert.equal(form.get("code_verifier"), "verifier");
  assert.equal(form.get("redirect_uri"), "https://app.example.com/cb");
  assert.equal(tokens.accessToken, "at1");
  assert.equal(tokens.refreshToken, "pbr_1");
  assert.equal(tokens.organization, "acme");
  assert.deepEqual(tokens.scope, ["projects:read", "projects:write"]);
  assert.ok(tokens.expiresAt > Date.now() + 3000 * 1000);
});

test("a public client sends its id in the body and no secret", async () => {
  const f = fake(() => json(tokenReply));
  await new PawabaseOAuth({ clientId: "pbc_pub", redirectUri: "http://127.0.0.1:9/cb", fetch: f.fetch }).exchangeCode({ code: "c", codeVerifier: "v" });
  assert.equal(f.calls[0]!.headers.authorization, undefined);
  assert.equal(new URLSearchParams(f.calls[0]!.body).get("client_id"), "pbc_pub");
});

test("an OAuth refusal becomes an OAuthError, and invalid_grant says to reconnect", async () => {
  const f = fake(() => json({ error: "invalid_grant", error_description: "The refresh token was revoked." }, 400));
  const oauth = new PawabaseOAuth({ ...app, fetch: f.fetch });
  await assert.rejects(oauth.refresh("pbr_old"), (e: OAuthError) => e.code === "invalid_grant" && e.needsReconnect && e.status === 400 && /revoked/.test(e.message));
  const slow = fake(() => json({ error: "slow_down", error_description: "Too many." }, 429, { "retry-after": "12" }));
  await assert.rejects(new PawabaseOAuth({ ...app, fetch: slow.fetch }).refresh("x"), (e: OAuthError) => e.code === "slow_down" && e.retryAfter === 12);
});

test("client credentials asks for the scopes and gets no refresh token", async () => {
  const f = fake(() => json({ access_token: "platform", expires_in: 3600, scope: "projects:write" }));
  const tokens = await new PawabaseOAuth({ ...app, fetch: f.fetch }).clientCredentials(["projects:write"]);
  const form = new URLSearchParams(f.calls[0]!.body);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("scope"), "projects:write");
  assert.equal(tokens.refreshToken, undefined);
});

test("revoke sends the token", async () => {
  const f = fake(() => json({}));
  await new PawabaseOAuth({ ...app, fetch: f.fetch }).revoke("pbr_1");
  assert.equal(f.calls[0]!.url, "https://dashboard.pawabase.com/oauth/revoke");
  assert.equal(new URLSearchParams(f.calls[0]!.body).get("token"), "pbr_1");
});

test("tokenSource gives the token while it is fresh, and refreshes once for many callers", async () => {
  const f = fake(() => json({ ...tokenReply, access_token: "at2", refresh_token: "pbr_2" }));
  const oauth = new PawabaseOAuth({ ...app, fetch: f.fetch });
  const saved: string[] = [];
  const stale = { accessToken: "at1", refreshToken: "pbr_1", expiresAt: Date.now() - 1000, scope: [], organization: "acme" };
  const token = oauth.tokenSource(stale, { onRefresh: (next) => void saved.push(next.refreshToken!) });
  const all = await Promise.all([token(), token(), token()]);
  assert.deepEqual(all, ["at2", "at2", "at2"]);
  assert.equal(f.calls.length, 1); // one refresh for three callers
  assert.deepEqual(saved, ["pbr_2"]);
  assert.equal(await token(), "at2");
  assert.equal(f.calls.length, 1); // fresh now: no more calls
});

test("the Management API sends the bearer token and answers JSON", async () => {
  const f = fake(() => json([{ ref: "mellow-dingo", name: "Portal", state: "running" }]));
  const cloud = new PawabaseCloud({ token: "pbp_x", fetch: f.fetch });
  const projects = await cloud.projects.list();
  assert.equal(projects[0]!.ref, "mellow-dingo");
  assert.equal(f.calls[0]!.url, "https://dashboard.pawabase.com/v1/projects");
  assert.equal(f.calls[0]!.headers.authorization, "Bearer pbp_x");
});

test("a token function is asked for every call", async () => {
  const f = fake(() => json({ organization: "acme" }));
  let n = 0;
  const cloud = new PawabaseCloud({ token: () => `t${++n}`, fetch: f.fetch });
  await cloud.whoami();
  await cloud.whoami();
  assert.deepEqual(f.calls.map((c) => c.headers.authorization), ["Bearer t1", "Bearer t2"]);
});

test("API errors become CloudError with the code and details", async () => {
  const f = fake(() => json({ error: "insufficient_scope", message: "Needs projects:write.", details: { needed: "projects:write" } }, 403));
  const cloud = new PawabaseCloud({ token: "t", fetch: f.fetch });
  await assert.rejects(cloud.projects.create({ name: "x" }), (e: CloudError) => e.status === 403 && e.code === "insufficient_scope" && (e.details as any).needed === "projects:write");
});

test("create, then wait until the project is running", async () => {
  let polls = 0;
  const f = fake((seen) => {
    if (seen.method === "POST") return json({ ref: "p1", state: "creating" }, 201);
    return json({ ref: "p1", state: ++polls < 3 ? "creating" : "running", default_environment: "acme-p1-development" });
  });
  const cloud = new PawabaseCloud({ token: "t", fetch: f.fetch });
  const made = await cloud.projects.create({ name: "Portal", app: "bookings", values: { SITE_URL: "https://x.example" } });
  assert.deepEqual(JSON.parse(f.calls[0]!.body), { name: "Portal", app: "bookings", values: { SITE_URL: "https://x.example" } });
  const ready = await cloud.projects.waitUntilRunning(made.ref, { interval: 1 });
  assert.equal(ready.default_environment, "acme-p1-development");
  assert.equal(polls, 3);
});

test("waiting throws when the project fails or an app fails to install", async () => {
  const failed = new PawabaseCloud({ token: "t", fetch: fake(() => json({ ref: "p1", state: "failed" })).fetch });
  await assert.rejects(failed.projects.waitUntilRunning("p1", { interval: 1 }), /ended up failed/);
  const app = new PawabaseCloud({ token: "t", fetch: fake(() => json({ ref: "p1", state: "running", app: { slug: "crm", state: "failed", error: "not empty" } })).fetch });
  await assert.rejects(app.projects.waitForApp("p1", { interval: 1 }), /not empty/);
});

test("createKey maps the options to the API's fields and returns the key once", async () => {
  const f = fake(() => json({ id: "k1", name: "Lumen", role: "secret", key: "pb_sk_abc" }, 201));
  const cloud = new PawabaseCloud({ token: "t", fetch: f.fetch });
  const made = await cloud.projects.createKey("p1", { name: "Lumen", role: "secret", allowedIps: ["10.0.0.0/8"], expiresAt: "2030-01-01T00:00:00Z", environment: "acme-p1-staging" });
  assert.equal(made.key, "pb_sk_abc");
  assert.equal(f.calls[0]!.url, "https://dashboard.pawabase.com/v1/projects/p1/api-keys?environment=acme-p1-staging");
  assert.deepEqual(JSON.parse(f.calls[0]!.body), { name: "Lumen", role: "secret", allowed_ips: ["10.0.0.0/8"], expires_at: "2030-01-01T00:00:00Z" });
});

test("the Studio API reaches a project's server by target and path", async () => {
  const f = fake(() => json({ data: [] }));
  const studio = new PawabaseCloud({ token: "t", fetch: f.fetch }).studio("p1");
  await studio.get("platform", "envs/acme-p1-development/resources", { q: "orders" });
  await studio.post("platform", "/envs/acme-p1-development/resources", { name: "orders" });
  assert.equal(f.calls[0]!.url, "https://dashboard.pawabase.com/v1/projects/p1/studio/platform/envs/acme-p1-development/resources?q=orders");
  assert.equal(f.calls[1]!.url, "https://dashboard.pawabase.com/v1/projects/p1/studio/platform/envs/acme-p1-development/resources");
  assert.equal(f.calls[1]!.method, "POST");
});
