import {
  AbortError,
  NetworkError,
  TimeoutError,
  errorFromResponse,
  parseRetryAfter,
  type ApiError,
} from "./errors.js";
import { VERSION } from "./version.js";
import { anySignal, backoff, queryString, sleep, trimSlash, type QueryValue } from "./util.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Extra attempts after the first. `0` disables retries. Default `2`. */
  retries?: number;
  /** First backoff ceiling in milliseconds. Default `300`. */
  baseDelayMs?: number;
  /** Largest backoff in milliseconds. Default `8000`. */
  maxDelayMs?: number;
  /**
   * The longest `Retry-After` the client will wait for. A server asking for more
   * is surfaced as a {@link RateLimitError} instead. Default `30000`.
   */
  maxRetryAfterMs?: number;
}

export interface RequestInfo {
  method: string;
  url: string;
  attempt: number;
}

export interface ResponseInfo extends RequestInfo {
  status: number;
  durationMs: number;
  requestId: string | null;
}

/** Observability hooks. Throwing inside a hook never fails the request. */
export interface Hooks {
  onRequest?: (info: RequestInfo & { headers: Record<string, string> }) => void;
  onResponse?: (info: ResponseInfo) => void;
  onRetry?: (info: RequestInfo & { reason: string; delayMs: number }) => void;
  onError?: (error: unknown, info: RequestInfo) => void;
}

/** Where the transport gets the signed-in user's access token. */
export interface TokenProvider {
  /** The current access token, refreshing it first when it is about to expire. `null` when signed out. */
  getAccessToken(): Promise<string | null>;
  /** Called after a `401` for `failed`. Returns a fresh token to retry with, or `null` to give up. */
  onUnauthorized(failed: string): Promise<string | null>;
}

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  headers: Record<string, string>;
  timeoutMs: number;
  retry: RetryOptions | false;
  hooks: Hooks;
  tokens: TokenProvider | null;
}

export type ParseAs = "json" | "text" | "blob" | "arrayBuffer" | "stream" | "response";

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, QueryValue | QueryValue[]>;
  /** An object is sent as JSON. Strings, `Blob`, `FormData`, buffers and streams are sent as they are. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | null | undefined;
  /** Per-attempt timeout. `0` disables it. Default: the client's `timeoutMs`. */
  timeoutMs?: number;
  retry?: RetryOptions | false;
  /**
   * Allow retrying after a network failure or `502`/`503`/`504` even for a method
   * that is not naturally safe to repeat (`POST`, `PATCH`). Only set it when repeating is harmless.
   */
  idempotent?: boolean;
  /** `user`: send the user's token when there is one (default). `none`: the API key alone. */
  auth?: "user" | "none";
  /**
   * Call an absolute URL as it is, sending neither the API key nor a token. For signed
   * URLs, which carry their own authority.
   */
  absoluteUrl?: string;
  /** An explicit user token for this one call, instead of the session's. */
  accessToken?: string | null;
  parse?: ParseAs;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const DEFAULT_RETRY: Required<RetryOptions> = {
  retries: 2,
  baseDelayMs: 300,
  maxDelayMs: 8000,
  maxRetryAfterMs: 30_000,
};

function isStream(body: unknown): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

function isRawBody(body: unknown): boolean {
  return (
    typeof body === "string" ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    isStream(body)
  );
}

export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  url(path: string, query?: RequestOptions["query"]): string {
    const base = trimSlash(this.config.baseUrl);
    return `${base}${path.startsWith("/") ? path : `/${path}`}${queryString(query)}`;
  }

  /** Make a request and return the parsed body (`undefined` for `204`). */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const response = await this.send(options);
    return (await this.read(response, options.parse ?? "json")) as T;
  }

  /** Make a request and return the raw `Response`. Non-2xx answers throw. */
  async send(options: RequestOptions): Promise<Response> {
    const method = (options.method ?? "GET").toUpperCase();
    const url = options.absoluteUrl ?? this.url(options.path, options.query);
    const anonymous = options.absoluteUrl !== undefined;
    const retry = this.retryPolicy(options.retry);
    const body = options.body;
    const replayable = !isStream(body);
    const idempotent = options.idempotent === true || SAFE_METHODS.has(method);

    let token: string | null = null;
    if (anonymous) token = null;
    else if (options.accessToken !== undefined) token = options.accessToken;
    else if (options.auth !== "none" && this.config.tokens) token = await this.config.tokens.getAccessToken();

    let attempt = 0;
    let refreshed = false;
    for (;;) {
      const info: RequestInfo = { method, url, attempt };
      const started = Date.now();
      let response: Response;
      try {
        response = await this.once(method, url, options, token, info, anonymous);
      } catch (error) {
        const retriable = error instanceof NetworkError || error instanceof TimeoutError;
        if (retriable && retry && idempotent && replayable && attempt < retry.retries) {
          const delayMs = backoff(attempt, retry);
          this.hook(() => this.config.hooks.onRetry?.({ ...info, reason: (error as Error).name, delayMs }));
          await sleep(delayMs, options.signal);
          attempt += 1;
          continue;
        }
        this.hook(() => this.config.hooks.onError?.(error, info));
        throw error;
      }

      this.hook(() =>
        this.config.hooks.onResponse?.({
          ...info,
          status: response.status,
          durationMs: Date.now() - started,
          requestId: response.headers.get("x-request-id"),
        }),
      );
      if (response.ok) return response;

      // A rejected token: refresh once and replay, unless the body cannot be replayed.
      if (
        response.status === 401 &&
        token &&
        !refreshed &&
        replayable &&
        options.auth !== "none" &&
        options.accessToken === undefined &&
        this.config.tokens
      ) {
        refreshed = true;
        const fresh = await this.config.tokens.onUnauthorized(token);
        if (fresh && fresh !== token) {
          await this.discard(response);
          token = fresh;
          continue;
        }
      }

      const error = await this.toError(response, method, url);
      const delayMs = this.retryDelay(error, response, attempt, retry, idempotent, replayable);
      if (delayMs !== null && retry) {
        this.hook(() =>
          this.config.hooks.onRetry?.({ ...info, reason: `status ${response.status}`, delayMs }),
        );
        await sleep(delayMs, options.signal);
        attempt += 1;
        continue;
      }
      this.hook(() => this.config.hooks.onError?.(error, info));
      throw error;
    }
  }

  private retryPolicy(override: RetryOptions | false | undefined): Required<RetryOptions> | null {
    const chosen = override === undefined ? this.config.retry : override;
    if (chosen === false) return null;
    const merged = { ...DEFAULT_RETRY, ...(this.config.retry === false ? {} : this.config.retry), ...chosen };
    return merged.retries > 0 ? merged : null;
  }

  private retryDelay(
    error: ApiError,
    response: Response,
    attempt: number,
    retry: Required<RetryOptions> | null,
    idempotent: boolean,
    replayable: boolean,
  ): number | null {
    if (!retry || !replayable || attempt >= retry.retries) return null;
    const status = response.status;
    // 429 is answered before a handler runs, so repeating any method is safe.
    const retryable = status === 429 || (RETRYABLE_STATUS.has(status) && idempotent);
    if (!retryable) return null;
    const asked = parseRetryAfter(response.headers.get("retry-after")) ?? error.retryAfter;
    if (asked !== null && asked !== undefined) {
      const ms = asked * 1000;
      return ms > retry.maxRetryAfterMs ? null : Math.ceil(ms);
    }
    return backoff(attempt, retry);
  }

  private async once(
    method: string,
    url: string,
    options: RequestOptions,
    token: string | null,
    info: RequestInfo,
    anonymous: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(anonymous ? {} : { apikey: this.config.apiKey, "x-client-info": `pawabase-js/${VERSION}`, ...this.config.headers }),
      ...options.headers,
    };
    if (token) headers["authorization"] = `Bearer ${token}`;

    let body: BodyInit | undefined;
    const raw = options.body;
    if (raw !== undefined && raw !== null) {
      if (isRawBody(raw)) {
        body = raw as BodyInit;
      } else {
        body = JSON.stringify(raw);
        if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    }

    this.hook(() =>
      this.config.hooks.onRequest?.({
        ...info,
        headers: { ...headers, ...(headers["apikey"] ? { apikey: "***" } : {}), ...(headers["authorization"] ? { authorization: "Bearer ***" } : {}) },
      }),
    );

    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const timeoutController = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => timeoutController.abort(new TimeoutError(timeoutMs)), timeoutMs) : null;
    const signal = anySignal([options.signal, timeoutMs > 0 ? timeoutController.signal : undefined]);
    const init: RequestInit & { duplex?: "half" } = { method, headers, ...(signal ? { signal } : {}) };
    if (body !== undefined) {
      init.body = body;
      if (isStream(body)) init.duplex = "half";
    }
    try {
      return await this.config.fetch(url, init);
    } catch (error) {
      if (options.signal?.aborted) throw new AbortError(undefined, { cause: error });
      if (timeoutController.signal.aborted) throw new TimeoutError(timeoutMs, { cause: error });
      throw new NetworkError(`Could not reach ${new URL(url).origin}: ${(error as Error)?.message ?? error}`, {
        cause: error,
        method,
        url,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async toError(response: Response, method: string, url: string): Promise<ApiError> {
    let body: unknown;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return errorFromResponse({ status: response.status, body, headers: response.headers, method, url });
  }

  private async discard(response: Response): Promise<void> {
    try {
      await response.arrayBuffer();
    } catch {
      /* the body is not needed */
    }
  }

  async read(response: Response, as: ParseAs): Promise<unknown> {
    if (as === "response") return response;
    if (as === "stream") return response.body;
    if (as === "blob") return response.blob();
    if (as === "arrayBuffer") return response.arrayBuffer();
    if (response.status === 204 || response.status === 205) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    if (as === "text") return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private hook(fn: () => void): void {
    try {
      fn();
    } catch {
      /* hooks observe; they must not break requests */
    }
  }
}
