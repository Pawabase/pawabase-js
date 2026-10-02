import { AbortError } from "./errors.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sleep for `ms`, rejecting early with {@link AbortError} when `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError(undefined, { cause: signal.reason }));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError(undefined, { cause: signal?.reason }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter: a random delay in `[0, min(max, base * factor^attempt)]`. */
export function backoff(
  attempt: number,
  options: { baseDelayMs: number; maxDelayMs: number; factor?: number },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * (options.factor ?? 2) ** attempt);
  return Math.floor(random() * ceiling);
}

/** One signal that fires when any of `signals` fires. Uses the platform's `AbortSignal.any` when present. */
export function anySignal(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => !!s);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (native) return native(real);
  const controller = new AbortController();
  for (const signal of real) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** `a/b c/d` to `a/b%20c/d`: encode each path segment, keep the slashes. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export type QueryValue = string | number | boolean | null | undefined | Date;

/** A query string from a flat record. Drops `undefined`/`null`; arrays repeat the key. */
export function queryString(params: Record<string, QueryValue | QueryValue[]> | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === undefined || item === null) continue;
      search.append(key, item instanceof Date ? item.toISOString() : String(item));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Decode a JWT payload without verifying it (the server verifies). Returns `null` for malformed tokens. */
export function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const text =
      typeof atob === "function"
        ? decodeURIComponent(
            Array.from(atob(base64), (ch) => "%" + ch.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
          )
        : (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } }).Buffer.from(base64, "base64").toString("utf8");
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a key is a secret key (`pb_sk_…`, or `sk_…` in older docs). */
export function isSecretKey(apiKey: string): boolean {
  return /^(pb_)?sk_/.test(apiKey);
}
