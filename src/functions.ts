import type { HttpClient } from "./http.js";
import type { QueryValue } from "./util.js";
import { encodePath } from "./util.js";

export interface CallOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal | null | undefined;
  timeoutMs?: number;
  /** Allow retrying a `POST` after a network failure. Only when running it twice is harmless. */
  idempotent?: boolean;
}

function pass(options: CallOptions): {
  headers?: Record<string, string>;
  signal?: AbortSignal | null | undefined;
  timeoutMs?: number;
  idempotent?: boolean;
} {
  return {
    ...(options.headers ? { headers: options.headers } : {}),
    signal: options.signal,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.idempotent !== undefined ? { idempotent: options.idempotent } : {}),
  };
}

export interface FetchOptions extends CallOptions {
  method?: string;
  query?: Record<string, QueryValue | QueryValue[]>;
  /** An object is sent as JSON; strings, `Blob`, `FormData`, buffers and streams as they are. */
  body?: unknown;
  /** Run the function deployed on this branch (`x-pawabase-branch`). */
  branch?: string;
}

/** Functions you wrote in your project's code, invoked at `/functions/v1/<name>`. */
export class FunctionsClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Call a function and return what it returned. The API key needs the
   * `functions:invoke` scope (an unrestricted key has it).
   */
  async invoke<T = unknown>(name: string, input?: unknown, options: CallOptions = {}): Promise<T> {
    const body = await this.http.request<{ data: T } | undefined>({
      method: "POST",
      path: `/functions/v1/${encodePath(name)}`,
      body: input === undefined ? undefined : input,
      ...pass(options),
    });
    return (body as { data: T } | undefined)?.data as T;
  }

  /**
   * Call an HTTP function (`functions/<name>/index.ts`) with any method and path, and get its `Response` as it is — status, headers
   * and a streaming body. An error status is returned, not thrown; the API key and the signed-in user's token are sent as for any call.
   *
   * ```ts
   * const res = await pawabase.functions.fetch("orders", "/42/items", { method: "POST", body: { sku: "A1" } });
   * if (res.ok) console.log(await res.json());
   * ```
   */
  fetch(name: string, path = "/", options: FetchOptions = {}): Promise<Response> {
    const rest = path === "/" || path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
    return this.http.send({
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      path: `/functions/v1/${encodePath(name)}${rest}`,
      ...(options.query ? { query: options.query } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...pass({ ...options, headers: { ...(options.branch ? { "x-pawabase-branch": options.branch } : {}), ...options.headers } }),
      throwOnError: false,
    });
  }
}

/**
 * Flows with an HTTP trigger that has no path, invoked at `/flows/v1/<name>`.
 * (Flows bound to a path are reached as routes, see {@link RoutesClient}.)
 */
export class FlowsClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Run a flow and return its response body: whatever its `response.return` block sends,
   * or `{ data: … }` with the flow's result when it has none.
   */
  run<T = unknown>(name: string, input?: unknown, options: CallOptions = {}): Promise<T> {
    return this.http.request<T>({
      method: "POST",
      path: `/flows/v1/${encodePath(name)}`,
      body: input === undefined ? undefined : input,
      ...pass(options),
    });
  }
}

export interface RouteOptions extends CallOptions {
  query?: Record<string, QueryValue | QueryValue[]>;
  body?: unknown;
}

/** Custom routes you defined, served under `/rest/v1/<path>`. */
export class RoutesClient {
  constructor(private readonly http: HttpClient) {}

  call<T = unknown>(method: string, path: string, options: RouteOptions = {}): Promise<T> {
    return this.http.request<T>({
      method,
      path: `/rest/v1/${encodePath(path.replace(/^\/+/, ""))}`,
      ...(options.query ? { query: options.query } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...pass(options),
    });
  }

  get<T = unknown>(path: string, options: Omit<RouteOptions, "body"> = {}): Promise<T> {
    return this.call<T>("GET", path, options);
  }
  post<T = unknown>(path: string, body?: unknown, options: Omit<RouteOptions, "body"> = {}): Promise<T> {
    return this.call<T>("POST", path, { ...options, body });
  }
  put<T = unknown>(path: string, body?: unknown, options: Omit<RouteOptions, "body"> = {}): Promise<T> {
    return this.call<T>("PUT", path, { ...options, body });
  }
  patch<T = unknown>(path: string, body?: unknown, options: Omit<RouteOptions, "body"> = {}): Promise<T> {
    return this.call<T>("PATCH", path, { ...options, body });
  }
  delete<T = unknown>(path: string, options: Omit<RouteOptions, "body"> = {}): Promise<T> {
    return this.call<T>("DELETE", path, options);
  }
}
