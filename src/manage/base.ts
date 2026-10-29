import type { HttpClient } from "../http.js";
import type { QueryValue } from "../util.js";

/** What the management plane answers: a JSON document (lists are `{ data: [...] }`). */
export type Api = Record<string, any>;
export type Query = Record<string, QueryValue | QueryValue[]>;
export type Body = Record<string, unknown>;

/** URL path segments, each encoded: `seg("flows", name, "run")` → `/flows/<name>/run`. */
export function seg(...parts: Array<string | number>): string {
  return "/" + parts.map((part) => encodeURIComponent(String(part))).join("/");
}

/** Everything a management service shares: the environment a call is for, and the five verbs. */
export class Service {
  constructor(
    protected readonly http: HttpClient,
    private readonly environmentName: string,
  ) {}

  /** The environment this service manages. */
  get environment(): string {
    return this.environmentName;
  }

  protected path(suffix = ""): string {
    return `/platform/v1/envs/${encodeURIComponent(this.environmentName)}${suffix}`;
  }

  protected get<T = Api>(suffix = "", query?: Query): Promise<T> {
    return this.http.request<T>({ path: this.path(suffix), ...(query ? { query } : {}) });
  }

  protected post<T = Api>(suffix = "", body?: unknown, query?: Query): Promise<T> {
    return this.http.request<T>({ method: "POST", path: this.path(suffix), body, ...(query ? { query } : {}) });
  }

  protected put<T = Api>(suffix: string, body?: unknown, query?: Query): Promise<T> {
    return this.http.request<T>({ method: "PUT", path: this.path(suffix), body, ...(query ? { query } : {}) });
  }

  protected patch<T = Api>(suffix: string, body?: unknown, query?: Query): Promise<T> {
    return this.http.request<T>({ method: "PATCH", path: this.path(suffix), body, ...(query ? { query } : {}) });
  }

  protected del<T = Api>(suffix: string, query?: Query, body?: unknown): Promise<T> {
    return this.http.request<T>({ method: "DELETE", path: this.path(suffix), ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) });
  }

  /** A call that is not scoped to an environment (`/platform/v1/...`). */
  protected project<T = Api>(method: string, suffix: string, options: { body?: unknown; query?: Query; parse?: "json" | "text" | "response" } = {}): Promise<T> {
    return this.http.request<T>({ method, path: `/platform/v1${suffix}`, ...options });
  }
}

/**
 * A kind of definition an environment holds (`flows`, `policies`, `webhooks`…): list, get, create, replace, remove.
 * Pass `branch` to work on a feature branch's draft instead of the live environment. A definition is addressed by its name
 * (inbound hooks: their slug).
 */
export class Definitions extends Service {
  protected readonly kind: string = "";

  list(options: { branch?: string } = {}): Promise<Api> {
    return this.get(seg(this.kind), { branch: options.branch });
  }

  getOne(key: string, options: { branch?: string } = {}): Promise<Api> {
    return this.get(seg(this.kind, key), { branch: options.branch });
  }

  create(body: Body, options: { branch?: string } = {}): Promise<Api> {
    return this.post(seg(this.kind), body, { branch: options.branch });
  }

  replace(key: string, body: Body, options: { branch?: string } = {}): Promise<Api> {
    return this.put(seg(this.kind, key), body, { branch: options.branch });
  }

  remove(key: string, options: { branch?: string } = {}): Promise<Api> {
    return this.del(seg(this.kind, key), { branch: options.branch });
  }
}
