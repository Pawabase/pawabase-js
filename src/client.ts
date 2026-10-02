import { AuthClient, type AuthOptions } from "./auth.js";
import { ResourceClient, type AnyRow, type ResourceTypes } from "./data.js";
import { ConfigError } from "./errors.js";
import { StorageClient } from "./files.js";
import { FlowsClient, FunctionsClient, RoutesClient } from "./functions.js";
import { HttpClient, type FetchLike, type Hooks, type RetryOptions, type TokenProvider } from "./http.js";
import { RealtimeClient, type RealtimeOptions } from "./realtime.js";
import { MemoryStorage } from "./session-store.js";
import { isSecretKey, trimSlash } from "./util.js";

/** The shape `createClient<Database>()` expects. `pawabase-types` generates one from your project. */
export interface DatabaseShape {
  resources: Record<string, ResourceTypes<any, any, any>>;
}

type Untyped = { resources: Record<string, ResourceTypes> };

export interface ClientOptions {
  /** The gateway's origin, e.g. `https://api.example.com`. */
  url: string;
  /** The project API key: `pb_pk_…` (publishable, safe in a browser) or `pb_sk_…` (secret, servers only). */
  apiKey: string;
  /**
   * The project's ref and the environment's name. Optional: only social sign-in needs them
   * (its URL names the environment), and they are sent as scope hints to the gateway.
   */
  project?: string;
  environment?: string;
  /** Per-attempt timeout in milliseconds. Default `30000`; `0` disables it. */
  timeoutMs?: number;
  /** Retry policy for rate limits, `502`/`503`/`504` and network failures. `false` to never retry. */
  retry?: RetryOptions | false;
  /** Your `fetch` (Node < 18 polyfills, React Native, a test double, instrumentation). */
  fetch?: FetchLike;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
  hooks?: Hooks;
  auth?: AuthOptions;
  realtime?: RealtimeOptions;
  /**
   * Use this user's access token instead of a stored session: a string, or a function
   * (for frameworks that own the session). With it the client keeps no session, does not
   * refresh, and is meant for one server-side request.
   */
  accessToken?: string | (() => string | null | Promise<string | null>);
  /** A secret key in a browser leaks it to every visitor, so it is refused. Set this to override. */
  dangerouslyAllowBrowser?: boolean;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof (globalThis as { document?: unknown }).document !== "undefined";
}

function staticTokens(source: NonNullable<ClientOptions["accessToken"]>): TokenProvider {
  const get = async () => (typeof source === "string" ? source : await source());
  return { getAccessToken: get, onUnauthorized: async () => null };
}

/**
 * The entry point.
 *
 * ```ts
 * const pawabase = createClient({ url: "https://api.example.com", apiKey: "pb_pk_…" });
 * await pawabase.auth.signInWithPassword({ email, password });
 * const { data } = await pawabase.from("posts").eq("status", "live").order("created_at", "desc");
 * ```
 */
export class PawabaseClient<DB extends DatabaseShape = Untyped> {
  readonly http: HttpClient;
  /** Sign-in, session lifecycle and the signed-in user. */
  readonly auth: AuthClient;
  /** Storage buckets. */
  readonly storage: StorageClient;
  /** Functions: `/functions/v1`. */
  readonly functions: FunctionsClient;
  /** Flows with a pathless HTTP trigger: `/flows/v1`. */
  readonly flows: FlowsClient;
  /** Custom routes: `/rest/v1/<path>`. */
  readonly routes: RoutesClient;
  /** Channels, presence and publishing. */
  readonly realtime: RealtimeClient;

  constructor(readonly options: ClientOptions) {
    if (!options.url) throw new ConfigError("createClient needs the gateway `url`.");
    if (!options.apiKey) throw new ConfigError("createClient needs an `apiKey`.");
    let origin: URL;
    try {
      origin = new URL(options.url);
    } catch {
      throw new ConfigError(`"${options.url}" is not a valid URL.`);
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new ConfigError("The `url` must start with http:// or https://.");
    }
    if (isSecretKey(options.apiKey) && isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new ConfigError(
        "A secret key (pb_sk_…) must never run in a browser: it bypasses every policy and anyone can read it. Use a publishable key (pb_pk_…) here, or set `dangerouslyAllowBrowser`.",
      );
    }
    const fetchImpl: FetchLike | undefined =
      options.fetch ?? (typeof fetch === "function" ? ((input, init) => fetch(input, init)) : undefined);
    if (!fetchImpl) throw new ConfigError("No `fetch` is available. Pass one in the options.");

    const stateless = options.accessToken !== undefined;
    const config = {
      baseUrl: trimSlash(options.url),
      apiKey: options.apiKey,
      fetch: fetchImpl,
      headers: {
        ...(options.project ? { "x-project-id": options.project } : {}),
        ...(options.environment ? { "x-environment": options.environment } : {}),
        ...options.headers,
      },
      timeoutMs: options.timeoutMs ?? 30_000,
      retry: options.retry ?? ({} as RetryOptions),
      hooks: options.hooks ?? {},
      tokens: null as TokenProvider | null,
    };
    this.http = new HttpClient(config);
    this.auth = new AuthClient(this.http, {
      ...(stateless ? { persistSession: false, autoRefreshToken: false, storage: new MemoryStorage(), detectSessionInUrl: false } : {}),
      ...options.auth,
      ...(options.project ? { project: options.project } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
    config.tokens = stateless ? staticTokens(options.accessToken as NonNullable<ClientOptions["accessToken"]>) : this.auth;
    this.storage = new StorageClient(this.http);
    this.functions = new FunctionsClient(this.http);
    this.flows = new FlowsClient(this.http);
    this.routes = new RoutesClient(this.http);
    this.realtime = new RealtimeClient(this.http, stateless ? null : this.auth, {
      ...options.realtime,
      ...(options.project ? { project: options.project } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
  }

  /**
   * Records of a resource. With a generated `Database` type the name and row types are checked;
   * without one rows are `Record<string, unknown>`.
   */
  from<K extends keyof DB["resources"] & string>(
    name: K,
  ): ResourceClient<DB["resources"][K]["Row"], DB["resources"][K]["Insert"], DB["resources"][K]["Update"]> {
    return new ResourceClient(this.http, name);
  }

  /** Records of a resource, typed by hand: `pawabase.resource<Post, NewPost>("posts")`. */
  resource<Row = AnyRow, Insert = Partial<Row>, Update = Partial<Row>>(name: string): ResourceClient<Row, Insert, Update> {
    return new ResourceClient<Row, Insert, Update>(this.http, name);
  }

  /** A client that acts as one user, from a token you hold (a server rendering a page, an edge function). It keeps no session. */
  asUser(accessToken: string | (() => string | null | Promise<string | null>)): PawabaseClient<DB> {
    return new PawabaseClient<DB>({ ...this.options, accessToken });
  }

  /**
   * A raw request to any path on the gateway, with the key and the user's token attached,
   * the retry policy and the typed errors applied. For endpoints the client has no method for.
   */
  request<T = unknown>(method: string, path: string, options: { body?: unknown; query?: Record<string, string | number | boolean | undefined | null>; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
    return this.http.request<T>({
      method,
      path,
      ...(options.query ? { query: options.query } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      signal: options.signal,
    });
  }

  /** The health of every Pawabase service behind the gateway. */
  status(): Promise<{ ok: boolean; services?: Record<string, { ok: boolean }> }> {
    return this.http.request({ path: "/v1/status", auth: "none", headers: {} });
  }

  /** Stop timers and close the realtime connection. Call when discarding a client. */
  dispose(): void {
    this.realtime.disconnect();
    this.auth.dispose();
  }
}

/** Create a client. See {@link ClientOptions}. */
export function createClient<DB extends DatabaseShape = Untyped>(options: ClientOptions): PawabaseClient<DB> {
  return new PawabaseClient<DB>(options);
}
