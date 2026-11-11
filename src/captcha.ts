/**
 * Bot protection, as the client sees it.
 *
 * When an environment protects sign-up or sign-in, a request may be refused with `captcha_required` and the check to solve. This module
 * handles that for the auth client: the built-in proof of work is solved here with no widget and nothing for you to write; for a
 * hosted provider (Turnstile, hCaptcha, reCAPTCHA) you supply `auth.captcha.getToken`, which shows that provider's widget and returns
 * its token. A solved check earns a clearance that is remembered and sent with later requests, so people are rarely asked twice.
 *
 * ```ts
 * const pawabase = createClient({
 *   url, apiKey,
 *   auth: { captcha: { getToken: (challenge) => showTurnstile(challenge.site_key, challenge.action) } },
 * });
 * ```
 */
import { AbortError, ApiError, ConfigError } from "./errors.js";
import type { HttpClient, RequestOptions } from "./http.js";
import type { SessionStorage } from "./session-store.js";

/** An auth action, or your own form's name (lowercase letters, digits, `_` and `-`, up to 32). */
export type CaptchaAction = "signup" | "signin" | "magic_link" | "email_code" | "recover" | "verify_resend" | "anonymous" | (string & {});
export type CaptchaProvider = "pawabase" | "turnstile" | "hcaptcha" | "recaptcha";

/** What the server asks to be solved. For `pawabase` it is a puzzle; for the others, the provider's site key to render its widget with. */
export interface CaptchaChallenge {
  provider: CaptchaProvider;
  action: CaptchaAction;
  /** Hosted providers: the public key their widget needs. */
  site_key?: string;
  /** The action as the provider's widget must be given it (reCAPTCHA allows no `-`). */
  provider_action?: string;
  recaptcha_version?: "v2" | "v3";
  /** Built in: the signed puzzle to hand back with its answer. */
  challenge?: string;
  algorithm?: "sha256";
  salt?: string;
  /** Built in: how many leading zero bits the answer's hash must have. */
  bits?: number;
  /** Built in: Unix time (seconds) after which the puzzle is refused. */
  expires_at?: number;
}

export interface CaptchaOptions {
  /**
   * Called when a hosted provider's check is needed: show its widget and resolve with the token it gives. Returning `null` (the person
   * closed it) lets the original error through.
   */
  getToken?: (challenge: CaptchaChallenge) => Promise<string | null> | string | null;
  /** Solve the built-in proof of work without asking. Default `true`. */
  autoSolve?: boolean;
  /** Called while the built-in check is being solved, so a form can say "Checking…". */
  onSolving?: (solving: boolean) => void;
}

const PATHS: Record<string, CaptchaAction> = {
  "/auth/v1/signup": "signup",
  "/auth/v1/token": "signin",
  "/auth/v1/magic-link": "magic_link",
  "/auth/v1/email-code": "email_code",
  "/auth/v1/recover": "recover",
  "/auth/v1/verify/request": "verify_resend",
  "/auth/v1/anonymous": "anonymous",
};

/** The check a refused request asks for, or `null` when the error is about something else. */
export function captchaChallengeOf(error: unknown): CaptchaChallenge | null {
  if (!(error instanceof ApiError) || (error.code !== "captcha_required" && error.code !== "captcha_failed")) return null;
  const details = error.details as { captcha?: CaptchaChallenge } | null | undefined;
  return details && typeof details === "object" && details.captcha ? details.captcha : null;
}

/** Whether an error means "solve the security check" (as opposed to wrong details, a block, or an outage). */
export function isCaptchaError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === "captcha_required" || error.code === "captcha_failed");
}

// ── SHA-256, for the one case needed: a message that fits a single block ──

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first two words of SHA-256 of `bytes[0..length)`, which must be at most 55 bytes. Enough to count up to 64 leading zero bits. */
function headOfSha256(bytes: Uint8Array, length: number, w: Uint32Array): [number, number] {
  w.fill(0, 0, 16);
  for (let i = 0; i < length; i++) w[i >> 2]! |= bytes[i]! << (24 - (i & 3) * 8);
  w[length >> 2]! |= 0x80 << (24 - (length & 3) * 8);
  w[15] = length * 8;
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15]!;
    const b = w[i - 2]!;
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
  }
  let a = 0x6a09e667;
  let b = 0xbb67ae85;
  let c = 0x3c6ef372;
  let d = 0xa54ff53a;
  let e = 0x510e527f;
  let f = 0x9b05688c;
  let g = 0x1f83d9ab;
  let h = 0x5be0cd19;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  return [(a + 0x6a09e667) >>> 0, (b + 0xbb67ae85) >>> 0];
}

function zeroBits(first: number, second: number): number {
  if (first !== 0) return Math.clz32(first);
  return 32 + (second === 0 ? 32 : Math.clz32(second));
}

/**
 * Solve the built-in proof of work and return the token to send. It works in short bursts and yields in between, so the page stays
 * responsive; the usual puzzle takes a few milliseconds, a hard one (an address under suspicion) a second or two.
 */
export async function solveChallenge(challenge: CaptchaChallenge, options: { signal?: AbortSignal | null } = {}): Promise<string> {
  const { salt, bits } = challenge;
  if (challenge.provider !== "pawabase" || !challenge.challenge || !salt || !bits) throw new TypeError("This is not a built-in challenge to solve.");
  const prefix = `${salt}:`;
  if (prefix.length > 40) throw new TypeError("The challenge is longer than this solver handles.");
  const bytes = new Uint8Array(56);
  for (let i = 0; i < prefix.length; i++) bytes[i] = prefix.charCodeAt(i);
  const words = new Uint32Array(64);
  const BURST = 1 << 14;
  for (let nonce = 0; nonce < 2 ** 40; ) {
    for (const end = nonce + BURST; nonce < end; nonce++) {
      const text = String(nonce);
      for (let i = 0; i < text.length; i++) bytes[prefix.length + i] = text.charCodeAt(i);
      const [first, second] = headOfSha256(bytes, prefix.length + text.length, words);
      if (zeroBits(first, second) >= bits) return `pow1.${challenge.challenge}.${nonce}`;
    }
    if (options.signal?.aborted) throw new AbortError("The security check was cancelled.");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The security check could not be solved.");
}

/** Sends the protected auth requests: attaches a token or the remembered clearance, and answers a `captcha_required` once. */
export class CaptchaGate {
  private clearance: string | null | undefined;

  constructor(
    private readonly http: HttpClient,
    private readonly storage: SessionStorage,
    private readonly storageKey: string,
    private readonly options: CaptchaOptions = {},
  ) {}

  /** Ask ahead whether an action needs a check right now, and get it: to show a widget before the person submits. */
  async challenge(action: CaptchaAction, email?: string): Promise<{ required: boolean; mode: string; captcha: CaptchaChallenge | null }> {
    return this.http.request({ method: "POST", path: "/auth/v1/captcha/challenge", body: { action, ...(email ? { email } : {}) }, auth: "none" });
  }

  private async remembered(): Promise<string | null> {
    if (this.clearance === undefined) {
      try {
        this.clearance = (await this.storage.getItem(this.storageKey)) ?? null;
      } catch {
        this.clearance = null;
      }
    }
    return this.clearance;
  }

  private async remember(value: string | null): Promise<void> {
    this.clearance = value;
    try {
      if (value) await this.storage.setItem(this.storageKey, value);
      else await this.storage.removeItem(this.storageKey);
    } catch {
      /* storage unavailable: the clearance lasts for this page only */
    }
  }

  private async run<T>(options: RequestOptions, extra: Record<string, string>): Promise<T> {
    const response = await this.http.send({ ...options, headers: { ...options.headers, ...extra } });
    const earned = response.headers.get("x-captcha-clearance");
    if (earned) await this.remember(earned);
    return (await this.http.read(response, options.parse ?? "json")) as T;
  }

  /** Make an auth request. Requests to paths that are never protected go straight through. */
  async request<T = unknown>(options: RequestOptions, token?: string | null): Promise<T> {
    const action = PATHS[options.path];
    const grant = (options.body as { grant_type?: string } | undefined)?.grant_type;
    if (!action || (action === "signin" && grant !== undefined && grant !== "password")) return this.http.request<T>(options);
    if (token) return this.run<T>(options, { "x-captcha-token": token });
    const clearance = await this.remembered();
    try {
      return await this.run<T>(options, clearance ? { "x-captcha-clearance": clearance } : {});
    } catch (error) {
      const challenge = captchaChallengeOf(error);
      if (!challenge) throw error;
      if (clearance) await this.remember(null); // it has run out
      let solved: string | null = null;
      if (challenge.provider === "pawabase") {
        if (this.options.autoSolve === false) throw error;
        this.options.onSolving?.(true);
        try {
          solved = await solveChallenge(challenge, { signal: options.signal ?? null });
        } finally {
          this.options.onSolving?.(false);
        }
      } else if (this.options.getToken) {
        solved = await this.options.getToken(challenge);
      }
      if (!solved) throw error;
      return this.run<T>(options, { "x-captcha-token": solved });
    }
  }
}

/** A pass a form sends to its backend: single use, for one action, good for five minutes. */
export interface CaptchaPass {
  pass: string;
  action: string;
  /** Unix time (seconds). */
  expires_at: number;
}

/** What `siteverify` says about a pass: Turnstile's and reCAPTCHA's shape, plus Pawabase's own fields. */
export interface CaptchaVerification {
  success: boolean;
  "error-codes": string[];
  action?: string;
  hostname?: string | null;
  challenge_ts?: string;
  provider?: string;
  /** 0 (certainly automated) to 1 (certainly a person). */
  score?: number;
  /** Issued while the provider was unreachable and the environment chose to let people through. */
  unverified?: boolean;
  /** Whether the pass came from the address you gave as `remoteip`. */
  same_address?: boolean | null;
  reason?: string;
}

export interface PrepareResult {
  required: boolean;
  mode: string;
  captcha: CaptchaChallenge | { provider: "none"; action: string } | null;
  unavailable?: boolean;
}

/**
 * Bot protection for any form or request, beside the auth calls (which `auth` protects on its own).
 *
 * ```ts
 * // In the browser: earn a pass and send it with the form.
 * const { pass } = await pawabase.captcha.protect("contact");
 * await fetch("/api/contact", { method: "POST", body: JSON.stringify({ ...form, captcha: pass }) });
 *
 * // On your server, with a secret key: check it.
 * const result = await admin.captcha.verify(pass, { action: "contact", remoteip });
 * if (!result.success) throw new Error("Failed the security check");
 * ```
 */
export class CaptchaClient {
  constructor(
    private readonly http: HttpClient,
    private readonly options: CaptchaOptions = {},
  ) {}

  /** What to solve for an action: the built-in puzzle, a provider's widget, or nothing. */
  prepare(action: string): Promise<PrepareResult> {
    return this.http.request({ method: "POST", path: "/auth/v1/captcha/challenge", body: { action }, auth: "none" });
  }

  /** Swap what was solved for a pass. */
  redeem(action: string, token: string | null): Promise<CaptchaPass> {
    return this.http.request({ method: "POST", path: "/auth/v1/captcha/redeem", body: { action, token }, auth: "none" });
  }

  /**
   * Earn a pass for an action: ask, solve, redeem. The built-in check is solved here; a hosted provider's widget is shown by
   * `getToken` (this call's, else the client's `auth.captcha.getToken`). A wrong answer is retried once with the fresh check it comes back with.
   */
  async protect(action: string, options: { getToken?: CaptchaOptions["getToken"]; signal?: AbortSignal | null } = {}): Promise<CaptchaPass> {
    const prepared = await this.prepare(action);
    if (prepared.unavailable) {
      throw new ApiError({ status: 503, code: "captcha_unavailable", message: "The security check is not available right now. Try again in a minute." });
    }
    const getToken = options.getToken ?? this.options.getToken;
    const solve = async (challenge: PrepareResult["captcha"]): Promise<string | null> => {
      if (!challenge || challenge.provider === "none") return null;
      if (challenge.provider === "pawabase") {
        this.options.onSolving?.(true);
        try {
          return await solveChallenge(challenge as CaptchaChallenge, { signal: options.signal ?? null });
        } finally {
          this.options.onSolving?.(false);
        }
      }
      if (!getToken) throw new ConfigError(`This environment checks with ${challenge.provider}: pass getToken to show its widget.`);
      const token = await getToken(challenge as CaptchaChallenge);
      if (!token) throw new AbortError("The security check was closed.");
      return token;
    };
    try {
      return await this.redeem(action, await solve(prepared.captcha));
    } catch (error) {
      const fresh = captchaChallengeOf(error);
      if (!fresh) throw error;
      return this.redeem(action, await solve(fresh));
    }
  }

  /**
   * Check a pass a form sent you. Server only: it needs a secret key. `action` refuses a pass earned for another form; `remoteip` (the
   * visitor's address) lowers the score of a pass shown from somewhere else.
   */
  verify(pass: string, options: { action?: string; remoteip?: string } = {}): Promise<CaptchaVerification> {
    return this.http.request({
      method: "POST",
      path: "/auth/v1/captcha/siteverify",
      body: { response: pass, ...(options.action ? { action: options.action } : {}), ...(options.remoteip ? { remoteip: options.remoteip } : {}) },
      auth: "none",
    });
  }
}
