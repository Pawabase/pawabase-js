import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ApiError, AuthenticationError, ConfigError, ConflictError, MemoryStorage, createClient, type Session } from "../src/index.js";
import { closeAll, serve, sessionBody, tick, until, user } from "./helpers.js";

after(closeAll);

const base = { apiKey: "pk_test", retry: false as const };

function memoryClient(url: string, extra: Record<string, unknown> = {}) {
  return createClient({ url, ...base, auth: { storage: new MemoryStorage(), autoRefreshToken: false }, ...extra });
}

test("signUp signs the user in and emits SIGNED_IN", async () => {
  const fake = await serve((req) =>
    req.path === "/auth/v1/signup" ? { status: 201, body: { ...sessionBody(), verification_required: false } } : undefined,
  );
  const client = memoryClient(fake.url);
  const events: string[] = [];
  client.auth.onAuthStateChange((event) => events.push(event));
  const result = await client.auth.signUp({ email: "ada@example.com", password: "pw", data: { plan: "free" }, redirectTo: "https://app/ok" });
  assert.equal(result.verificationRequired, false);
  assert.ok(result.session);
  assert.deepEqual(fake.requests[0]!.json, { email: "ada@example.com", password: "pw", data: { plan: "free" }, redirect_to: "https://app/ok" });
  assert.equal(fake.requests[0]!.headers["authorization"], undefined);
  assert.equal((await client.auth.getSession())?.user.email, "ada@example.com");
  await tick();
  assert.deepEqual(events, ["INITIAL_SESSION", "SIGNED_IN"]);
  client.dispose();
});

test("signUp that needs email confirmation returns no session", async () => {
  const fake = await serve(() => ({ status: 201, body: { user: user(), session: null, verification_required: true } }));
  const client = memoryClient(fake.url);
  const result = await client.auth.signUp({ email: "a@b.co", password: "pw" });
  assert.equal(result.verificationRequired, true);
  assert.equal(result.session, null);
  assert.equal(await client.auth.getSession(), null);
  client.dispose();
});

test("a taken email is a ConflictError", async () => {
  const fake = await serve(() => ({ status: 409, body: "an account with this email already exists" }));
  const client = memoryClient(fake.url);
  await assert.rejects(client.auth.signUp({ email: "a@b.co", password: "pw" }), ConflictError);
  client.dispose();
});

test("signInWithPassword stores the session, and later requests use its token", async () => {
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/token") return { body: sessionBody(3600, { access_token: "tok-1" }) };
    if (req.path === "/rest/v1/posts") return { body: { data: [], page: 1, per_page: 20, total: 0 } };
    return undefined;
  });
  const client = memoryClient(fake.url);
  const result = await client.auth.signInWithPassword({ email: "ada@example.com", password: "pw" });
  assert.equal(result.status, "signed_in");
  await client.from("posts").list();
  assert.equal(fake.requests.at(-1)!.headers["authorization"], "Bearer tok-1");
  client.dispose();
});

test("a wrong password is an ApiError and nothing is stored", async () => {
  const fake = await serve(() => ({ status: 400, body: "invalid email or password" }));
  const client = memoryClient(fake.url);
  await assert.rejects(client.auth.signInWithPassword({ email: "x@y.z", password: "no" }), (e: unknown) => e instanceof ApiError && e.status === 400);
  assert.equal(await client.auth.getSession(), null);
  client.dispose();
});

test("MFA: the sign-in pauses, verify(code) finishes it", async () => {
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/token" && req.json.grant_type === "password") {
      return { body: { mfa_required: true, mfa_token: "chal-1", factors: ["totp", "recovery_code"] } };
    }
    if (req.path === "/auth/v1/token" && req.json.grant_type === "mfa") return { body: sessionBody(3600, { access_token: "aal2-token" }) };
    return undefined;
  });
  const client = memoryClient(fake.url);
  const result = await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  assert.equal(result.status, "mfa_required");
  if (result.status !== "mfa_required") return;
  assert.deepEqual(result.factors, ["totp", "recovery_code"]);
  assert.equal(await client.auth.getSession(), null, "no session before the second factor");
  const session = await result.verify("123456");
  assert.equal(session.access_token, "aal2-token");
  assert.deepEqual(fake.requests.at(-1)!.json, { grant_type: "mfa", mfa_token: "chal-1", code: "123456" });
  client.dispose();
});

test("an expiring session is refreshed before it is used; concurrent callers share one refresh", async () => {
  let refreshes = 0;
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/token") {
      refreshes += 1;
      return { body: sessionBody(3600, { access_token: "fresh", refresh_token: "r2" }), delayMs: 30 };
    }
    return { body: { data: [], page: 1, per_page: 20, total: 0 } };
  });
  const client = memoryClient(fake.url);
  await client.auth.initialized();
  // @ts-expect-error seed an almost-expired session
  client.auth.session = sessionBody(10, { access_token: "stale", refresh_token: "r1" });
  await Promise.all([client.from("a").list(), client.from("b").list(), client.auth.getSession()]);
  assert.equal(refreshes, 1);
  assert.equal(fake.requests.filter((r) => r.path.startsWith("/rest")).every((r) => r.headers["authorization"] === "Bearer fresh"), true);
  assert.deepEqual(fake.requests[0]!.json, { grant_type: "refresh_token", refresh_token: "r1" });
  client.dispose();
});

test("a refresh token the server refuses signs the user out", async () => {
  const fake = await serve(() => ({ status: 400, body: "the refresh token is not valid" }));
  const client = memoryClient(fake.url);
  await client.auth.initialized();
  // @ts-expect-error seed
  client.auth.session = sessionBody(5);
  const events: string[] = [];
  client.auth.onAuthStateChange((e) => events.push(e));
  assert.equal(await client.auth.getSession(), null);
  assert.ok(events.includes("SIGNED_OUT"));
  client.dispose();
});

test("a refresh that fails for a passing reason keeps a still-valid session", async () => {
  const fake = await serve(() => ({ status: 503, body: "busy" }));
  const client = memoryClient(fake.url);
  await client.auth.initialized();
  const seeded = sessionBody(30); // inside the 60 s margin but not expired
  // @ts-expect-error seed
  client.auth.session = seeded;
  const session = await client.auth.getSession();
  assert.equal(session?.access_token, seeded.access_token);
  client.dispose();
});

test("the auto-refresh timer renews the session before it expires", async () => {
  let n = 0;
  const fake = await serve(() => ({ body: sessionBody(3600, { access_token: `auto-${++n}` }) }));
  const client = createClient({ url: fake.url, ...base, auth: { storage: new MemoryStorage(), refreshMarginSeconds: 3598 } });
  await client.auth.initialized();
  const events: string[] = [];
  client.auth.onAuthStateChange((e) => events.push(e));
  // @ts-expect-error seed a session that expires in 3600 s; the margin makes the timer fire in ~2 s
  client.auth.session = sessionBody(3600, { access_token: "first" });
  // @ts-expect-error private
  client.auth.schedule();
  await until(() => events.includes("TOKEN_REFRESHED"), 5000);
  assert.equal((await client.auth.getSession())?.access_token, "auto-1");
  client.dispose();
});

test("a session persists in the storage and is read by a new client", async () => {
  const fake = await serve(() => ({ body: sessionBody(3600, { access_token: "kept" }) }));
  const storage = new MemoryStorage();
  const first = createClient({ url: fake.url, ...base, auth: { storage, autoRefreshToken: false } });
  await first.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  first.dispose();
  const second = createClient({ url: fake.url, ...base, auth: { storage, autoRefreshToken: false } });
  assert.equal((await second.auth.getSession())?.access_token, "kept");
  second.dispose();
});

test("a corrupt stored session is discarded", async () => {
  const fake = await serve(() => ({ body: {} }));
  const storage = new MemoryStorage();
  const client0 = memoryClient(fake.url);
  // Find the key the client uses by writing through a sign-in, then corrupting it.
  const key = (client0.auth as unknown as { storageKey: string }).storageKey;
  client0.dispose();
  storage.setItem(key, "{not json");
  const client = createClient({ url: fake.url, ...base, auth: { storage, autoRefreshToken: false } });
  assert.equal(await client.auth.getSession(), null);
  assert.equal(storage.getItem(key), null);
  client.dispose();
});

test("signOut calls the server, clears the session, and still clears when the token is already dead", async () => {
  const fake = await serve((req) => (req.path === "/auth/v1/logout" ? { status: 401, body: "sign in first" } : { body: sessionBody() }));
  const client = memoryClient(fake.url);
  await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  const events: string[] = [];
  client.auth.onAuthStateChange((e) => events.push(e));
  await client.auth.signOut({ scope: "global" });
  assert.deepEqual(fake.requests.at(-1)!.json, { scope: "global" });
  assert.equal(await client.auth.getSession(), null);
  assert.ok(events.includes("SIGNED_OUT"));
  client.dispose();
});

test("signOut clears locally even when the server is down, and reports it", async () => {
  const fake = await serve((req) => (req.path === "/auth/v1/logout" ? { status: 500, text: "boom" } : { body: sessionBody() }));
  const client = memoryClient(fake.url);
  await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  await assert.rejects(client.auth.signOut());
  assert.equal(await client.auth.getSession(), null);
  client.dispose();
});

test("signOut(others) keeps this session", async () => {
  const fake = await serve((req) => (req.path === "/auth/v1/logout" ? { body: { signed_out: true } } : { body: sessionBody() }));
  const client = memoryClient(fake.url);
  await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  await client.auth.signOut({ scope: "others" });
  assert.ok(await client.auth.getSession());
  client.dispose();
});

test("updateUser patches then returns the fresh user, and emits USER_UPDATED", async () => {
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/token") return { body: sessionBody() };
    if (req.method === "PATCH") return { body: user({ name: "Ada L." }) };
    if (req.path === "/auth/v1/user") return { body: user({ name: "Ada L." }) };
    return undefined;
  });
  const client = memoryClient(fake.url);
  await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  const events: string[] = [];
  client.auth.onAuthStateChange((e) => events.push(e));
  const updated = await client.auth.updateUser({ name: "Ada L.", data: { theme: "dark" } });
  assert.equal(updated.name, "Ada L.");
  assert.ok(events.includes("USER_UPDATED"));
  assert.equal((await client.auth.getCachedUser())?.name, "Ada L.");
  client.dispose();
});

test("magic link: request, then verify returns a session", async () => {
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/magic-link") return { body: { sent: true } };
    if (req.path === "/auth/v1/magic-link/verify") return { body: sessionBody() };
    return undefined;
  });
  const client = memoryClient(fake.url);
  await client.auth.signInWithMagicLink({ email: "a@b.co", redirectTo: "https://app", createUser: false });
  assert.deepEqual(fake.requests[0]!.json, { email: "a@b.co", redirect_to: "https://app", create_user: false });
  const result = await client.auth.verifyMagicLink("a-long-token-123");
  assert.equal(result.status, "signed_in");
  client.dispose();
});

test("password reset signs the user in with the returned session", async () => {
  const fake = await serve((req) => (req.path === "/auth/v1/recover" ? { body: { sent: true } } : { body: sessionBody(3600, { access_token: "reset" }) }));
  const client = memoryClient(fake.url);
  await client.auth.requestPasswordReset({ email: "a@b.co" });
  const session = await client.auth.resetPassword({ token: "token-123456", password: "new-pw" });
  assert.equal(session.access_token, "reset");
  assert.equal((await client.auth.getSession())?.access_token, "reset");
  client.dispose();
});

test("switchOrg refreshes with the organization; null clears it", async () => {
  const fake = await serve((req) => ({ body: sessionBody(3600, { org: req.json.org ?? null, org_role: req.json.org ? "admin" : null }) }));
  const client = memoryClient(fake.url);
  await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  const inOrg = await client.auth.switchOrg("acme");
  assert.equal(inOrg.org, "acme");
  assert.equal(fake.requests.at(-1)!.json.org, "acme");
  const out = await client.auth.switchOrg(null);
  assert.equal(out.org, null);
  assert.ok("org" in fake.requests.at(-1)!.json, "null is sent so the server clears the org");
  client.dispose();
});

test("the OAuth URL needs the project and environment", async () => {
  const fake = await serve(() => ({ body: {} }));
  const without = memoryClient(fake.url);
  assert.throws(() => without.auth.signInWithOAuthUrl("github"), ConfigError);
  without.dispose();
  const client = memoryClient(fake.url, { project: "acme", environment: "production" });
  const url = new URL(client.auth.signInWithOAuthUrl("github", { redirectTo: "https://app/cb" }));
  assert.equal(url.pathname, "/auth/v1/authorize/acme/production/github");
  assert.equal(url.searchParams.get("redirect_to"), "https://app/cb");
  assert.equal(url.searchParams.get("apikey"), "pk_test");
  client.dispose();
});

test("getSessionFromUrl reads tokens, errors, links and MFA from a fragment", async () => {
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/user") return { body: user({ email: "oauth@example.com" }) };
    if (req.path === "/auth/v1/token") return { body: sessionBody(3600, { access_token: "after-mfa" }) };
    return undefined;
  });
  const client = memoryClient(fake.url);
  const payload = new URLSearchParams({ access_token: "oauth-access", refresh_token: "oauth-refresh", expires_in: "3600", token_type: "bearer" });
  const ok = await client.auth.getSessionFromUrl(`https://app.example/cb#${payload}`);
  assert.equal(ok.status, "signed_in");
  assert.equal((await client.auth.getSession())?.access_token, "oauth-access");
  assert.equal(fake.requests[0]!.headers["authorization"], "Bearer oauth-access");

  assert.deepEqual(await client.auth.getSessionFromUrl("https://app/cb#error=account_disabled"), { status: "error", error: "account_disabled" });
  assert.deepEqual(await client.auth.getSessionFromUrl("https://app/cb#linked=github"), { status: "linked", provider: "github" });
  assert.deepEqual(await client.auth.getSessionFromUrl("https://app/cb"), { status: "none" });
  const mfa = await client.auth.getSessionFromUrl("https://app/cb#mfa_required=true&mfa_token=chal");
  assert.equal(mfa.status, "mfa_required");
  if (mfa.status === "mfa_required") assert.equal((await mfa.verify("111111")).access_token, "after-mfa");
  client.dispose();
});

test("listeners get INITIAL_SESSION once, unsubscribe stops them, and a throwing listener is harmless", async () => {
  const fake = await serve(() => ({ body: sessionBody() }));
  const client = memoryClient(fake.url);
  const seen: string[] = [];
  const sub = client.auth.onAuthStateChange((event) => seen.push(event));
  client.auth.onAuthStateChange(() => { throw new Error("listener bug"); });
  await tick(20);
  await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  sub.unsubscribe();
  await client.auth.signOut();
  assert.deepEqual(seen, ["INITIAL_SESSION", "SIGNED_IN"]);
  client.dispose();
});

test("setSession adopts tokens from elsewhere and fetches the user", async () => {
  const fake = await serve(() => ({ body: user({ email: "ssr@example.com" }) }));
  const client = memoryClient(fake.url);
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const exp = Math.floor(Date.now() / 1000) + 600;
  const session = await client.auth.setSession({ access_token: jwt({ exp, org: "acme" }), refresh_token: "r" });
  assert.equal(session.user.email, "ssr@example.com");
  assert.equal(session.expires_at, exp);
  assert.equal(session.org, "acme");
  client.dispose();
});

test("asUser acts as one user and keeps no session or refresh", async () => {
  const fake = await serve((req) => (req.headers["authorization"] === "Bearer user-jwt" ? { body: { data: [], page: 1, per_page: 20, total: 0 } } : { status: 401, body: "Authentication required" }));
  const client = memoryClient(fake.url);
  const scoped = client.asUser("user-jwt");
  await scoped.from("posts").list();
  assert.equal(fake.requests.at(-1)!.headers["authorization"], "Bearer user-jwt");
  const wrong = client.asUser(() => "other");
  await assert.rejects(wrong.from("posts").list(), AuthenticationError);
  assert.equal(fake.requests.filter((r) => r.path === "/auth/v1/token").length, 0, "no refresh was attempted");
  scoped.dispose();
  wrong.dispose();
  client.dispose();
});

test("mfa, sessions and orgs call the documented paths", async () => {
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/token") return { body: sessionBody() };
    if (req.path === "/auth/v1/mfa/totp/enroll") return { body: { factor_id: "1", secret: "S", otpauth_uri: "otpauth://x" } };
    if (req.path === "/auth/v1/mfa/totp/verify") return { body: { enabled: true, recovery_codes: ["a", "b"] } };
    if (req.path === "/auth/v1/sessions") return { body: { data: [{ id: "s1", current: true }] } };
    if (req.path === "/auth/v1/orgs") return { body: { data: [{ slug: "acme" }] } };
    return { body: {} };
  });
  const client = memoryClient(fake.url);
  await client.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  assert.equal((await client.auth.mfa.enroll()).secret, "S");
  const codes = await client.auth.mfa.verifyEnrollment("123456");
  assert.deepEqual(codes.recovery_codes, ["a", "b"]);
  assert.equal((await client.auth.sessions.list())[0]!.id, "s1");
  assert.equal((await client.auth.orgs.list())[0]!.slug, "acme");
  await client.auth.sessions.revoke("s 1");
  await client.auth.orgs.invite("acme", { email: "n@b.co", role: "admin" });
  await client.auth.orgs.setMemberRole("acme", "7", "viewer");
  const paths = fake.requests.map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.includes("DELETE /auth/v1/sessions/s%201"));
  assert.ok(paths.includes("POST /auth/v1/orgs/acme/invitations"));
  assert.ok(paths.includes("PUT /auth/v1/orgs/acme/members/7"));
  client.dispose();
});

test("two tabs: a session another tab already refreshed is adopted instead of refreshing again", async () => {
  // Simulated with a shared storage: the second client finds a newer refresh token in storage.
  let refreshes = 0;
  const fake = await serve(() => {
    refreshes += 1;
    return { body: sessionBody(3600) };
  });
  const storage = new MemoryStorage();
  const a = createClient({ url: fake.url, ...base, auth: { storage, autoRefreshToken: false } });
  await a.auth.initialized();
  const key = (a.auth as unknown as { storageKey: string }).storageKey;
  const stale = sessionBody(5, { refresh_token: "old" });
  // @ts-expect-error seed this tab with a stale session
  a.auth.session = stale;
  const fresh: Session = sessionBody(3600, { refresh_token: "newer-from-other-tab" }) as unknown as Session;
  storage.setItem(key, JSON.stringify(fresh));
  const adopted = await a.auth.refreshSession();
  assert.equal(adopted.refresh_token, "newer-from-other-tab");
  assert.equal(refreshes, 0, "no token exchange: the other tab's result was used");
  a.dispose();
});
