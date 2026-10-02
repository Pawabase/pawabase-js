/**
 * Every failure the client raises is a {@link PawabaseError}.
 *
 * Pawabase answers errors in several shapes: a bare string (most `4xx`), a bare
 * array of validation issues (`422`), an `{error, message, details}` object
 * (functions, flows, the gateway) and Akountz's own `{detail}` bodies. The
 * client normalises all of them into one class hierarchy, so application code
 * checks `error.status`, `error.code` or `instanceof` and never parses a body.
 */

/** One field a request body was refused for (`422`). */
export interface ValidationIssue {
  /** Path to the field, e.g. `["body", "email"]` or `["query", "per_page"]`. */
  loc: Array<string | number>;
  /** The field name without the `body`/`query` prefix, e.g. `email`. */
  field: string;
  message: string;
  type?: string;
  input?: unknown;
}

export interface ApiErrorInit {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  body?: unknown;
  requestId?: string | null;
  method?: string;
  url?: string;
  retryAfter?: number | null;
  policy?: string | null;
  cause?: unknown;
}

/** The base class of everything this package throws. */
export class PawabaseError extends Error {
  override name = "PawabaseError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The server answered with an error status. */
export class ApiError extends PawabaseError {
  override name = "ApiError";
  /** HTTP status code. */
  readonly status: number;
  /**
   * A stable machine-readable code: the server's own (`rate_limit_exceeded`,
   * `invalid_api_key`, a flow's `raised` code…) or one derived from the status
   * (`unauthenticated`, `forbidden`, `not_found`, `conflict`, `validation_failed`,
   * `rate_limited`, `server_error`).
   */
  readonly code: string;
  /** Structured extras the server sent (validation issues, flow details). */
  readonly details: unknown;
  /** The parsed response body exactly as received. */
  readonly body: unknown;
  /** The `x-request-id` to quote to an operator; look it up in Studio → Observability. */
  readonly requestId: string | null;
  readonly method: string | undefined;
  readonly url: string | undefined;
  /** Seconds the server asked the caller to wait (`429`, `503`). */
  readonly retryAfter: number | null;
  /** The name of the policy that refused the request (`policy 'x' refused`), when stated. */
  readonly policy: string | null;

  constructor(init: ApiErrorInit) {
    super(init.message, { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.body = init.body;
    this.requestId = init.requestId ?? null;
    this.method = init.method;
    this.url = init.url;
    this.retryAfter = init.retryAfter ?? null;
    this.policy = init.policy ?? null;
  }

  /** True when `code` matches. Handy in `catch`: `if (e instanceof ApiError && e.is("not_found"))`. */
  is(code: string): boolean {
    return this.code === code;
  }
}

/** `401`: no or invalid credentials. The API key is wrong, or the user is not signed in (or the token expired). */
export class AuthenticationError extends ApiError {
  override name = "AuthenticationError";
}

/** `403`: signed in (or keyed) but not allowed. {@link ApiError.policy} names the refusing policy when stated. */
export class PermissionError extends ApiError {
  override name = "PermissionError";
}

/** `404`: no such record, route or file, or a read policy hides it. */
export class NotFoundError extends ApiError {
  override name = "NotFoundError";
}

/** `409`: a unique value is taken, or the request conflicts with current state. */
export class ConflictError extends ApiError {
  override name = "ConflictError";
}

/** `400`/`422`: the request was refused before any policy ran. See {@link issues}. */
export class ValidationError extends ApiError {
  override name = "ValidationError";
  readonly issues: ValidationIssue[];
  constructor(init: ApiErrorInit & { issues: ValidationIssue[] }) {
    super(init);
    this.issues = init.issues;
  }
  /** The first message for a field, or `undefined`. Useful for form errors. */
  fieldError(field: string): string | undefined {
    return this.issues.find((issue) => issue.field === field)?.message;
  }
  /** All issues by field: `{ email: ["must be a valid email"], … }`. */
  byField(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const issue of this.issues) (out[issue.field] ??= []).push(issue.message);
    return out;
  }
}

/** `413`: the body is larger than the gateway or bucket allows. */
export class PayloadTooLargeError extends ApiError {
  override name = "PayloadTooLargeError";
}

/** `429`: rate limited. {@link ApiError.retryAfter} is the wait in seconds. */
export class RateLimitError extends ApiError {
  override name = "RateLimitError";
}

/** `5xx`: the platform failed. `502`/`503`/`504` are retried automatically for safe requests. */
export class ServerError extends ApiError {
  override name = "ServerError";
}

/** The request never produced a response (offline, DNS, refused, reset). */
export class NetworkError extends PawabaseError {
  override name = "NetworkError";
  readonly method: string | undefined;
  readonly url: string | undefined;
  constructor(message: string, options?: { cause?: unknown; method?: string; url?: string }) {
    super(message, options);
    this.method = options?.method;
    this.url = options?.url;
  }
}

/** The request exceeded its `timeoutMs`. */
export class TimeoutError extends PawabaseError {
  override name = "TimeoutError";
  readonly timeoutMs: number;
  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`The request timed out after ${timeoutMs} ms.`, options);
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's `AbortSignal` fired. */
export class AbortError extends PawabaseError {
  override name = "AbortError";
  constructor(message = "The request was aborted.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The client was configured or used incorrectly (no URL, a secret key in a browser…). */
export class ConfigError extends PawabaseError {
  override name = "ConfigError";
}

/** A realtime operation failed: refused, not connected, or no acknowledgement. */
export class RealtimeError extends PawabaseError {
  override name = "RealtimeError";
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export function isPawabaseError(value: unknown): value is PawabaseError {
  return value instanceof PawabaseError;
}

/** Narrow to an {@link ApiError} with a given status. */
export function isApiError(value: unknown, status?: number): value is ApiError {
  return value instanceof ApiError && (status === undefined || value.status === status);
}

const STATUS_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "validation_failed",
  429: "rate_limited",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIssues(items: unknown[]): ValidationIssue[] {
  return items.map((item) => {
    if (isRecord(item)) {
      const loc = Array.isArray(item["loc"]) ? (item["loc"] as Array<string | number>) : [];
      const field =
        typeof item["field"] === "string"
          ? item["field"]
          : loc.filter((part) => part !== "body" && part !== "query" && part !== "path").join(".");
      const message = String(item["msg"] ?? item["message"] ?? "is invalid");
      return {
        loc,
        field,
        message,
        ...(typeof item["type"] === "string" ? { type: item["type"] } : {}),
        ...("input" in item ? { input: item["input"] } : {}),
      };
    }
    return { loc: [], field: "", message: String(item) };
  });
}

function summarise(issues: ValidationIssue[]): string {
  if (!issues.length) return "The request was refused.";
  return issues.map((i) => (i.field ? `${i.field}: ${i.message}` : i.message)).join("; ");
}

/** Parse `Retry-After`: delta seconds or an HTTP date. Returns seconds, or `null`. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - now) / 1000);
}

/** Turn a failed response into the right error class. */
export function errorFromResponse(input: {
  status: number;
  body: unknown;
  headers?: Headers | undefined;
  method?: string | undefined;
  url?: string | undefined;
}): ApiError {
  const { status, body } = input;
  const requestId = input.headers?.get("x-request-id") ?? null;
  let retryAfter = parseRetryAfter(input.headers?.get("retry-after"));
  let message = "";
  let code = STATUS_CODES[status] ?? (status >= 500 ? "server_error" : "http_error");
  let details: unknown;
  let issues: ValidationIssue[] | null = null;

  if (typeof body === "string") {
    message = body.trim();
  } else if (Array.isArray(body)) {
    issues = toIssues(body);
    message = summarise(issues);
    details = issues;
  } else if (isRecord(body)) {
    const detail = body["detail"];
    const named = body["error"];
    if (typeof named === "string") code = named;
    else if (typeof body["code"] === "string") code = body["code"] as string;
    if (typeof body["message"] === "string") message = body["message"] as string;
    else if (typeof detail === "string") message = detail;
    if (Array.isArray(detail)) {
      issues = toIssues(detail);
      message ||= summarise(issues);
      details = issues;
    } else if (Array.isArray(body["details"])) {
      details = body["details"];
      const asIssues = toIssues(body["details"] as unknown[]);
      if (asIssues.every((issue) => issue.field)) issues = asIssues;
      message ||= summarise(asIssues);
    } else if ("details" in body) {
      details = body["details"];
    }
    if (retryAfter === null && typeof body["retry_after"] === "number") retryAfter = body["retry_after"];
  }
  if (!message) message = `Request failed with status ${status}.`;

  const policyMatch = /policy '([^']+)' refused/.exec(message);
  const init: ApiErrorInit = {
    status,
    code,
    message,
    details,
    body,
    requestId,
    method: input.method,
    url: input.url,
    retryAfter,
    policy: policyMatch?.[1] ?? null,
  };

  if (status === 422 || (status === 400 && issues)) {
    return new ValidationError({ ...init, issues: issues ?? [] });
  }
  if (status === 401) return new AuthenticationError(init);
  if (status === 403) return new PermissionError(init);
  if (status === 404) return new NotFoundError(init);
  if (status === 409) return new ConflictError(init);
  if (status === 413) return new PayloadTooLargeError(init);
  if (status === 429) return new RateLimitError(init);
  if (status >= 500) return new ServerError(init);
  return new ApiError(init);
}

/**
 * A query the client refuses to send because the server would answer it wrongly
 * rather than refuse it: two filters on one field (the server keeps only the last),
 * or an `in` value that contains a comma (the server splits on commas).
 */
export class InvalidQueryError extends PawabaseError {
  override name = "InvalidQueryError";
}
