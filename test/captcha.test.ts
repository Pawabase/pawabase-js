import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { ApiError, MemoryStorage, captchaChallengeOf, createClient, isCaptchaError, solveChallenge, type CaptchaChallenge } from "../src/index.js";
import { closeAll, serve, sessionBody } from "./helpers.js";

after(closeAll);

const base = { apiKey: "pk_test", retry: false as const };

function puzzle(bits = 12, action = "signin"): CaptchaChallenge {
  return { provider: "pawabase", action: action as CaptchaChallenge["action"], algorithm: "sha256", challenge: "Ym9keQ.sig", salt: "s4ltS4ltS4ltS4ltS4ltAA", bits, expires_at: 9e9 };
}

function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const ch of hex) {
    const nibble = parseInt(ch, 16);
    if (nibble === 0) bits += 4;
    else return bits + Math.clz32(nibble) - 28;
  }
  return bits;
}

const required = (challenge: CaptchaChallenge, code = "captcha_required") => ({
  status: 403,
  body: { error: code, message: "Complete the security check to continue.", details: { captcha: challenge } },
});

test("solveChallenge finds an answer the server's own check accepts", async () => {
  for (const bits of [8, 12, 16]) {
    const challenge = puzzle(bits);
    const token = await solveChallenge(challenge);
    const [prefix, body, signature, nonce] = token.split(".");
    assert.equal(prefix, "pow1");
    assert.equal(`${body}.${signature}`, challenge.challenge);
    const digest = createHash("sha256").update(`${challenge.salt}:${nonce}`).digest("hex");
    assert.ok(leadingZeroBits(digest) >= bits, `${bits} bits: ${digest}`);
  }
  await assert.rejects(solveChallenge({ provider: "turnstile", action: "signin", site_key: "k" }), TypeError);
});

test("the built-in check is solved without the app doing anything, and the clearance is remembered", async () => {
  const fake = await serve((req) => {
    if (req.path !== "/auth/v1/token") return undefined;
    if (req.headers["x-captcha-token"]) return { body: sessionBody(), headers: { "x-captcha-clearance": "clear-1" } };
    if (req.headers["x-captcha-clearance"] === "clear-1") return { body: sessionBody() };
    return required(puzzle(10));
  });
  const solving: boolean[] = [];
  const client = createClient({ project: "P1", url: fake.url, ...base, auth: { storage: new MemoryStorage(), autoRefreshToken: false, captcha: { onSolving: (on) => solving.push(on) } } });
  const result = await client.auth.signInWithPassword({ email: "ada@example.com", password: "pw" });
  assert.equal(result.status, "signed_in");
  assert.equal(fake.requests.length, 2);
  assert.match(String(fake.requests[1]!.headers["x-captcha-token"]), /^pow1\.Ym9keQ\.sig\.\d+$/);
  assert.deepEqual(solving, [true, false]);

  // The next sign-in presents the clearance and is not asked.
  await client.auth.signInWithPassword({ email: "ada@example.com", password: "pw" });
  assert.equal(fake.requests.length, 3);
  assert.equal(fake.requests[2]!.headers["x-captcha-clearance"], "clear-1");
  client.dispose();
});

test("a hosted provider's widget is asked for through getToken", async () => {
  const turnstile: CaptchaChallenge = { provider: "turnstile", site_key: "0x4AAA", action: "signup" };
  const fake = await serve((req) => {
    if (req.path !== "/auth/v1/signup") return undefined;
    return req.headers["x-captcha-token"] === "widget-token" ? { status: 201, body: { ...sessionBody(), verification_required: false } } : required(turnstile);
  });
  const seen: CaptchaChallenge[] = [];
  const client = createClient({ project: "P1", 
    url: fake.url,
    ...base,
    auth: { storage: new MemoryStorage(), autoRefreshToken: false, captcha: { getToken: (challenge) => (seen.push(challenge), "widget-token") } },
  });
  const made = await client.auth.signUp({ email: "ada@example.com", password: "pw" });
  assert.ok(made.session);
  assert.deepEqual(seen, [turnstile]);
  client.dispose();
});

test("without a way to solve it, the refusal reaches the app with the check attached", async () => {
  const turnstile: CaptchaChallenge = { provider: "turnstile", site_key: "0x4AAA", action: "recover" };
  const fake = await serve((req) => (req.path === "/auth/v1/recover" ? required(turnstile) : undefined));
  const client = createClient({ project: "P1", url: fake.url, ...base, auth: { storage: new MemoryStorage(), autoRefreshToken: false } });
  await assert.rejects(client.auth.requestPasswordReset({ email: "ada@example.com" }), (error: unknown) => {
    assert.ok(isCaptchaError(error));
    assert.deepEqual(captchaChallengeOf(error), turnstile);
    return true;
  });
  assert.equal(fake.requests.length, 1);
  client.dispose();
});

test("a token the app supplies is sent as it is, and its failure is not retried", async () => {
  const fake = await serve((req) => (req.path === "/auth/v1/magic-link" ? required(puzzle(10, "magic_link"), "captcha_failed") : undefined));
  const client = createClient({ project: "P1", url: fake.url, ...base, auth: { storage: new MemoryStorage(), autoRefreshToken: false } });
  await assert.rejects(client.auth.signInWithMagicLink({ email: "ada@example.com", captchaToken: "mine" }), (error: unknown) => error instanceof ApiError && error.code === "captcha_failed");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.headers["x-captcha-token"], "mine");
  client.dispose();
});

test("a page can ask ahead whether a check is needed", async () => {
  const fake = await serve((req) => (req.path === "/auth/v1/captcha/challenge" ? { body: { required: true, mode: "always", captcha: puzzle(10) } } : undefined));
  const client = createClient({ project: "P1", url: fake.url, ...base, auth: { storage: new MemoryStorage(), autoRefreshToken: false } });
  const ahead = await client.auth.captchaChallenge("signin", "ada@example.com");
  assert.equal(ahead.required, true);
  assert.deepEqual(fake.requests[0]!.json, { action: "signin", email: "ada@example.com" });
  client.dispose();
});

test("captcha.protect earns a pass for a form, and captcha.verify checks it", async () => {
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/captcha/challenge") return { body: { required: true, mode: "always", captcha: puzzle(10, "contact") } };
    if (req.path === "/auth/v1/captcha/redeem") {
      return /^pow1\.Ym9keQ\.sig\.\d+$/.test(req.json.token) ? { body: { pass: "pbc1.ok", action: "contact", expires_at: 9e9 } } : { status: 403, body: { error: "captcha_failed", message: "no" } };
    }
    if (req.path === "/auth/v1/captcha/siteverify") return { body: { success: req.json.response === "pbc1.ok", action: "contact", "error-codes": [] } };
    return undefined;
  });
  const client = createClient({ project: "P1", url: fake.url, ...base, auth: { storage: new MemoryStorage(), autoRefreshToken: false } });
  const earned = await client.captcha.protect("contact");
  assert.equal(earned.pass, "pbc1.ok");
  assert.equal(fake.requests[1]!.json.action, "contact");
  const result = await client.captcha.verify(earned.pass, { action: "contact", remoteip: "203.0.113.5" });
  assert.equal(result.success, true);
  assert.deepEqual(fake.requests[2]!.json, { response: "pbc1.ok", action: "contact", remoteip: "203.0.113.5" });
  client.dispose();
});

test("captcha.protect asks getToken for a hosted provider, and redeems nothing when no check is required", async () => {
  const turnstile = { provider: "turnstile", site_key: "0x4", action: "contact", provider_action: "contact" };
  let required = true;
  const fake = await serve((req) => {
    if (req.path === "/auth/v1/captcha/challenge") return { body: required ? { required: true, mode: "always", captcha: turnstile } : { required: false, mode: "trusted", captcha: { provider: "none", action: "contact" } } };
    if (req.path === "/auth/v1/captcha/redeem") return { body: { pass: `pbc1.${req.json.token ?? "none"}`, action: "contact", expires_at: 9e9 } };
    return undefined;
  });
  const client = createClient({ project: "P1", url: fake.url, ...base, auth: { storage: new MemoryStorage(), autoRefreshToken: false } });
  await assert.rejects(client.captcha.protect("contact"), /pass getToken/);
  const shown: unknown[] = [];
  assert.equal((await client.captcha.protect("contact", { getToken: (c) => (shown.push(c), "widget") })).pass, "pbc1.widget");
  assert.deepEqual(shown, [turnstile]);
  required = false;
  assert.equal((await client.captcha.protect("contact")).pass, "pbc1.none");
  client.dispose();
});
