/**
 * Connect your product to Pawabase on a person's behalf, and manage their organization's projects.
 *
 * Two classes, which map onto the two halves of an integration:
 *
 * - {@link PawabaseOAuth} is **your registered app** (its client id and secret). It sends people to Pawabase to approve a connection, trades
 *   the code for tokens, keeps them fresh and ends the connection.
 * - {@link PawabaseCloud} is **one connection**: a token for one organization. It calls the Management API: projects, marketplace apps,
 *   API keys, and everything Studio can do inside a project.
 *
 * ```ts
 * import { PawabaseOAuth, PawabaseCloud } from "@pawabase/client/cloud";
 *
 * const oauth = new PawabaseOAuth({ clientId: process.env.PAWABASE_CLIENT_ID!, clientSecret: process.env.PAWABASE_CLIENT_SECRET!,
 *                                   redirectUri: "https://app.example.com/oauth/pawabase/callback" });
 *
 * // 1. Send the person to Pawabase (keep `state` and `codeVerifier` in their session)
 * const { url, state, codeVerifier } = await oauth.authorize({ scopes: ["projects:read", "projects:write"] });
 *
 * // 2. They come back to your callback: check state, trade the code
 * const tokens = await oauth.callback(callbackUrl, { state, codeVerifier });
 *
 * // 3. Use the connection. Tokens are refreshed for you, and each refresh is handed to you to save.
 * const pawabase = new PawabaseCloud({ token: oauth.tokenSource(tokens, { onRefresh: (next) => save(next) }) });
 * const projects = await pawabase.projects.list();
 * ```
 *
 * This module has no dependency beyond `fetch` and Web Crypto, so it runs on Node 20+, Bun, Deno, Workers and in a browser (a browser
 * must never hold a client secret: use PKCE without one, as a public client).
 */

/** Where Pawabase Cloud lives. A self-hosted Cloud passes its own address. */
export const PAWABASE_CLOUD_URL = "https://dashboard.pawabase.com";

/** Every scope an app can ask for. */
export const SCOPES = ["organizations:read", "projects:read", "projects:write", "project:read", "project:write"] as const;
export type Scope = (typeof SCOPES)[number];

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// ── errors ─────────────────────────────────────────────────────────────────

/** An answer from `/oauth/*` that says no: `error` is the standard OAuth code, such as `invalid_grant` or `access_denied`. */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(
    /** The OAuth error code: `invalid_grant`, `invalid_client`, `access_denied`, `slow_down`, … */
    readonly code: string,
    message: string,
    /** The HTTP status, or `0` when the person was sent back with an error and no request was made. */
    readonly status = 0,
    /** Seconds to wait, from a `429 slow_down`. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }

  /** The connection is over (disconnected, expired, or a copy was used): ask the person to connect again. */
  get needsReconnect(): boolean {
    return this.code === "invalid_grant";
  }
}

/** An answer from `/v1/*` that says no. `code` is the API's error code, such as `insufficient_scope`, `plan_limit` or `not_found`. */
export class CloudError extends Error {
  override readonly name = "CloudError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** What the API added: the scope that was needed, the plan limit, the fields that were wrong. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// ── OAuth ──────────────────────────────────────────────────────────────────

/** What a connection holds. Keep it on your server, with your own user record: treat it like a password. */
export interface OAuthTokens {
  accessToken: string;
  /** Absent for a platform app's own token (client credentials). */
  refreshToken?: string;
  /** When the access token stops working, in milliseconds since the epoch (already 30 seconds early). */
  expiresAt: number;
  /** The scopes this connection holds. */
  scope: string[];
  /** The slug of the organization the person picked. Absent for client credentials, where it is the app's own. */
  organization?: string;
}

export interface OAuthOptions {
  /** Your app's client id (`pbc_…`). */
  clientId: string;
  /** Your app's client secret (`pbs_…`). Leave it out for a public client (a desktop app, a CLI), which relies on PKCE alone. */
  clientSecret?: string;
  /** One of the callback URLs registered for the app. Can be given per call instead. */
  redirectUri?: string;
  /** Pawabase Cloud's address. Defaults to {@link PAWABASE_CLOUD_URL}. */
  baseUrl?: string;
  fetch?: Fetch;
}

export interface AuthorizeOptions {
  /** What you want to do. Left out: every scope the app may ask for. */
  scopes?: readonly string[];
  /** Your own value, returned unchanged. Made for you (16 random bytes) when left out. */
  state?: string;
  redirectUri?: string;
}

/** What to keep in the person's session between sending them to Pawabase and their coming back. */
export interface PendingAuthorization {
  /** Send the browser here (a 302). */
  url: string;
  state: string;
  codeVerifier: string;
}

interface TokenReply {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  organization?: string;
}

const b64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomText = (bytes: number): string => b64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

/** The PKCE challenge for a verifier: its SHA-256, base64url without padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

const trim = (url: string): string => url.replace(/\/+$/, "");

/** Your registered app, talking to Pawabase's OAuth server. */
export class PawabaseOAuth {
  readonly clientId: string;
  readonly baseUrl: string;
  private readonly secret?: string;
  private readonly redirectUri?: string;
  private readonly fetcher: Fetch;
  private readonly flights = new Map<string, Promise<OAuthTokens>>();

  constructor(options: OAuthOptions) {
    if (!options.clientId) throw new Error("clientId is required (the pbc_… id of your app)");
    this.clientId = options.clientId;
    this.secret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.baseUrl = trim(options.baseUrl ?? PAWABASE_CLOUD_URL);
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** The server's own description of itself (RFC 8414): its endpoints, grants and scopes. */
  async metadata(): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${this.baseUrl}/.well-known/oauth-authorization-server`);
    if (!response.ok) throw new OAuthError("server_error", `Pawabase answered ${response.status}`, response.status);
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Step 1: the address to send the person to. It makes the `state` (against forged returns) and the PKCE verifier (so a stolen code is
   * useless); keep both in the person's session and give them back to {@link callback}.
   */
  async authorize(options: AuthorizeOptions = {}): Promise<PendingAuthorization> {
    const redirectUri = options.redirectUri ?? this.redirectUri;
    if (!redirectUri) throw new Error("redirectUri is required: pass it to the constructor or to authorize()");
    const state = options.state ?? randomText(16);
    const codeVerifier = randomText(48); // 64 characters
    const query = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      code_challenge: await pkceChallenge(codeVerifier),
      code_challenge_method: "S256",
    });
    if (options.scopes?.length) query.set("scope", options.scopes.join(" "));
    return { url: `${this.baseUrl}/oauth/authorize?${query}`, state, codeVerifier };
  }

  /**
   * Step 2, for your callback route: read what Pawabase sent back, check it is the sign-in you started, and trade the code for tokens.
   * Throws an {@link OAuthError} if the person declined (`access_denied`), the `state` is wrong, or the code is refused.
   *
   * Never retry this on a network error: a code works once, and a second use ends the connection. Start the sign-in again instead.
   */
  async callback(returned: string | URL | URLSearchParams, saved: { state: string; codeVerifier: string }, redirectUri?: string): Promise<OAuthTokens> {
    const query = returned instanceof URLSearchParams ? returned : new URL(String(returned), "https://placeholder.invalid").searchParams;
    const error = query.get("error");
    if (error) throw new OAuthError(error, query.get("error_description") || error);
    if (!saved.state || query.get("state") !== saved.state) throw new OAuthError("invalid_state", "This sign-in was not started here.");
    const code = query.get("code");
    if (!code) throw new OAuthError("invalid_request", "Pawabase did not send a code.");
    return this.exchangeCode({ code, codeVerifier: saved.codeVerifier, redirectUri });
  }

  /** Trade a code for tokens. Prefer {@link callback}, which checks the state first. */
  async exchangeCode(input: { code: string; codeVerifier?: string; redirectUri?: string }): Promise<OAuthTokens> {
    const redirectUri = input.redirectUri ?? this.redirectUri;
    return this.token({
      grant_type: "authorization_code",
      code: input.code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    });
  }

  /**
   * Trade a refresh token for a new pair. **The old refresh token stops working**: save the new one before using the new access token.
   * Two refreshes of one connection at once end it, so refresh through {@link tokenSource}, which keeps them to one at a time.
   */
  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /**
   * A platform app acting on its own organization, with no person involved. Needs the client secret. The token it returns has no
   * refresh token: ask again when it expires.
   */
  clientCredentials(scopes?: readonly string[]): Promise<OAuthTokens> {
    return this.token({ grant_type: "client_credentials", ...(scopes?.length ? { scope: scopes.join(" ") } : {}) });
  }

  /**
   * End the connection, so it disappears from the organization's Connected apps. Send the refresh token to end the whole connection;
   * an access token ends only that token. Always succeeds for a known client, even for a token Pawabase doesn't recognise.
   */
  async revoke(token: string): Promise<void> {
    const response = await this.post("/oauth/revoke", { token });
    if (!response.ok) throw await failure(response);
  }

  /**
   * A function that always returns a working access token, for {@link PawabaseCloud}. It refreshes a minute before expiry, one refresh
   * at a time per connection (in this process: across processes, hold a lock of your own around `onRefresh`'s storage), and calls
   * `onRefresh` with each new pair so you can save it before it is used.
   */
  tokenSource(tokens: OAuthTokens, options: { onRefresh?: (next: OAuthTokens) => void | Promise<void> } = {}): () => Promise<string> {
    let current = tokens;
    return async () => {
      if (Date.now() < current.expiresAt - 30_000) return current.accessToken;
      if (!current.refreshToken) throw new OAuthError("invalid_grant", "The access token has expired and there is no refresh token.", 400);
      const key = current.refreshToken;
      let flight = this.flights.get(key);
      if (!flight) {
        flight = this.refresh(key)
          .then(async (next) => {
            current = next;
            await options.onRefresh?.(next);
            return next;
          })
          .finally(() => this.flights.delete(key));
        this.flights.set(key, flight);
      }
      return (await flight).accessToken;
    };
  }

  // ── plumbing ──

  private async post(path: string, form: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const body = new URLSearchParams(form);
    if (this.secret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.secret)}`)}`;
    else body.set("client_id", this.clientId);
    return this.fetcher(`${this.baseUrl}${path}`, { method: "POST", headers, body });
  }

  private async token(form: Record<string, string>): Promise<OAuthTokens> {
    const response = await this.post("/oauth/token", form);
    if (!response.ok) throw await failure(response);
    const reply = (await response.json()) as TokenReply;
    return {
      accessToken: reply.access_token,
      refreshToken: reply.refresh_token,
      expiresAt: Date.now() + (reply.expires_in - 30) * 1000,
      scope: (reply.scope ?? "").split(" ").filter(Boolean),
      organization: reply.organization,
    };
  }
}

async function failure(response: Response): Promise<OAuthError> {
  const body = (await response.json().catch(() => null)) as { error?: string; error_description?: string } | null;
  const wait = Number(response.headers.get("retry-after"));
  return new OAuthError(body?.error ?? "server_error", body?.error_description ?? `Pawabase answered ${response.status}`, response.status, Number.isFinite(wait) && wait > 0 ? wait : undefined);
}

// ── the Management API ─────────────────────────────────────────────────────

export interface Organization {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  role: string;
  /** Only on `organizations.get`. */
  plan?: string;
  status?: string;
  usage?: { projects: number };
}

export interface ProjectApp {
  slug: string;
  state: "waiting" | "installing" | "installed" | "failed";
  error?: string | null;
}

export interface Project {
  id: string;
  /** How you name the project in calls: the same as its `slug`. */
  ref: string;
  slug: string;
  organization: string;
  name: string;
  description: string | null;
  state: "creating" | "running" | "paused" | "failed";
  /** Where the project's own API answers, once it is running. */
  endpoints: { api?: string };
  studio: boolean;
  /** The full name of the project's first environment (what clients send as `x-environment`). `null` until it is running. */
  default_environment: string | null;
  app: ProjectApp | null;
  integration: { name: string; client_id: string } | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  /** Only on `projects.get`. */
  environments?: { id: string; slug: string; key: string; schema: string; status: string; is_default: boolean }[] | null;
}

export interface WhoAmI {
  organization: string;
  role: string;
  scopes: string[];
  /** `grant` (an OAuth connection), `client` (a platform app's own token), `personal`, or `session`. */
  kind: "grant" | "client" | "personal" | "session";
  user: { id: string; email: string; name: string | null } | null;
  app: { name: string; client_id: string } | null;
}

export interface MarketplaceApp {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  version: string;
  publisher: string;
  counts: Record<string, number>;
  requires: string[];
  [more: string]: unknown;
}

export interface ApiKey {
  id: string;
  name: string;
  role: "publishable" | "secret";
  prefix: string;
  scopes: string[];
  environments: string[];
  expires_at: string | null;
  revoked_at: string | null;
  active: boolean;
  [more: string]: unknown;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  region?: string;
  /** A marketplace app's slug: it is installed as soon as the project is running. */
  app?: string;
  /** Values for the app's variables. */
  values?: Record<string, string>;
}

export interface CreateKeyInput {
  name: string;
  role?: "publishable" | "secret";
  /** `"all"`, or environment names. Left out: only the project's first. */
  environments?: "all" | string[];
  scopes?: string[];
  expiresAt?: string;
  allowedIps?: string[];
  allowedRoutes?: string[];
  /** The full name of the environment to make it in. Left out: the project's first. */
  environment?: string;
}

export interface CloudOptions {
  /** A token (an OAuth access token, a personal `pbp_…` token, or a platform app's token), or a function giving one: see {@link PawabaseOAuth.tokenSource}. */
  token: string | (() => string | Promise<string>);
  baseUrl?: string;
  fetch?: Fetch;
  /** Milliseconds before a call gives up. Calls into a project wait for its server, up to two minutes. Default 130000. */
  timeout?: number;
}

export interface WaitOptions {
  /** Milliseconds between checks. Default 2000 (do not poll faster). */
  interval?: number;
  /** Milliseconds to wait in all. Default 120000. */
  timeout?: number;
  signal?: AbortSignal;
}

/** One connection to Pawabase Cloud: the Management API for one organization. */
export class PawabaseCloud {
  readonly organizations: Organizations;
  readonly projects: Projects;
  readonly marketplace: Marketplace;
  readonly baseUrl: string;
  /** @internal */
  readonly getToken: () => string | Promise<string>;
  private readonly fetcher: Fetch;
  private readonly timeout: number;

  constructor(options: CloudOptions) {
    if (!options.token) throw new Error("token is required");
    this.getToken = typeof options.token === "function" ? options.token : () => options.token as string;
    this.baseUrl = trim(options.baseUrl ?? PAWABASE_CLOUD_URL);
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeout = options.timeout ?? 130_000;
    this.organizations = new Organizations(this);
    this.projects = new Projects(this);
    this.marketplace = new Marketplace(this);
  }

  /** What this token is: its organization, role, scopes, and who or what it acts for. Needs no scope. Call it right after connecting. */
  whoami(): Promise<WhoAmI> {
    return this.request("GET", "/token");
  }

  /**
   * Inside one project: everything Studio can do there, through `/v1/projects/{ref}/studio/…`. Reads need `project:read`, writes
   * `project:write`. See {@link ProjectStudio}.
   */
  studio(ref: string): ProjectStudio {
    return new ProjectStudio(this, ref);
  }

  /**
   * One call to `/v1`. The answer is the parsed JSON (or `undefined` for an empty one); an error answer throws {@link CloudError}.
   * Use it for an endpoint this class has no method for yet.
   */
  async request<T = any>(method: string, path: string, options: { body?: unknown; query?: Record<string, string | undefined>; signal?: AbortSignal } = {}): Promise<T> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) query.set(k, v);
    const url = `${this.baseUrl}/v1${path}${query.toString() ? `?${query}` : ""}`;
    const headers: Record<string, string> = { authorization: `Bearer ${await this.getToken()}`, accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const timer = new AbortController();
    const stop = setTimeout(() => timer.abort(), this.timeout);
    const link = () => timer.abort();
    options.signal?.addEventListener("abort", link, { once: true });
    try {
      const response = await this.fetcher(url, { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, signal: timer.signal });
      const text = await response.text();
      let data: any = undefined;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (!response.ok) throw new CloudError(response.status, data?.error ?? "error", data?.message ?? response.statusText, data?.details);
      return data as T;
    } finally {
      clearTimeout(stop);
      options.signal?.removeEventListener("abort", link);
    }
  }
}

class Organizations {
  constructor(private readonly c: PawabaseCloud) {}
  /** The token's organization, in a list (so code written for several works unchanged). Scope `organizations:read`. */
  list(): Promise<Organization[]> {
    return this.c.request("GET", "/organizations");
  }
  /** The organization with its plan and usage. `slug` must be the token's own. Scope `organizations:read`. */
  get(slug: string): Promise<Organization> {
    return this.c.request("GET", `/organizations/${encodeURIComponent(slug)}`);
  }
}

class Projects {
  constructor(private readonly c: PawabaseCloud) {}

  /** Scope `projects:read`. */
  list(): Promise<Project[]> {
    return this.c.request("GET", "/projects");
  }

  /** One project, with its environments. Scope `projects:read`. */
  get(ref: string): Promise<Project> {
    return this.c.request("GET", `/projects/${encodeURIComponent(ref)}`);
  }

  /** Scope `projects:write`, role member. Answers at once with the project in state `creating`: use {@link waitUntilRunning}. */
  create(input: CreateProjectInput): Promise<Project> {
    return this.c.request("POST", "/projects", { body: input });
  }

  /** Rename, or change the description (an empty one clears it). Scope `projects:write`, role admin. */
  update(ref: string, changes: { name?: string; description?: string }): Promise<Project> {
    return this.c.request("PATCH", `/projects/${encodeURIComponent(ref)}`, { body: changes });
  }

  /** Delete the project **and all its data**. It cannot be undone, and a protected project is refused (`protected`). Role admin. */
  delete(ref: string): Promise<{ deleted: string }> {
    return this.c.request("DELETE", `/projects/${encodeURIComponent(ref)}`);
  }

  pause(ref: string): Promise<Project> {
    return this.c.request("POST", `/projects/${encodeURIComponent(ref)}/pause`);
  }

  restore(ref: string): Promise<Project> {
    return this.c.request("POST", `/projects/${encodeURIComponent(ref)}/restore`);
  }

  /** A one-time link that hands a project to a person's own organization. Only a platform app's own token may call it. */
  claimLink(ref: string): Promise<{ claim_url: string; expires_at: string }> {
    return this.c.request("POST", `/projects/${encodeURIComponent(ref)}/claim`);
  }

  /** Install a marketplace app into an existing, empty project. Poll `get(ref)` and read `app.state`, or use {@link waitForApp}. */
  installApp(ref: string, app: string, values?: Record<string, string>): Promise<{ project: Project; app: ProjectApp }> {
    return this.c.request("POST", `/projects/${encodeURIComponent(ref)}/apps`, { body: { app, ...(values ? { values } : {}) } });
  }

  /** Wait until a new project is `running`. Throws if it ends up `failed` or `paused`, or if the wait runs out. */
  async waitUntilRunning(ref: string, options: WaitOptions = {}): Promise<Project> {
    return this.until(ref, (p) => p.state !== "creating", options, (p) => {
      if (p.state !== "running") throw new Error(`Project ${ref} ended up ${p.state}`);
    });
  }

  /** Wait until the project's marketplace app is `installed`. Throws with the reason if it `failed`. */
  async waitForApp(ref: string, options: WaitOptions = {}): Promise<Project> {
    return this.until(ref, (p) => p.app?.state === "installed" || p.app?.state === "failed", options, (p) => {
      if (p.app?.state === "failed") throw new Error(`The app failed to install: ${p.app.error ?? "no reason given"}`);
    });
  }

  /** The project's API keys (never their secret values). Scope `project:read`, role member. */
  async listKeys(ref: string): Promise<ApiKey[]> {
    return (await this.c.request<{ data: ApiKey[] }>("GET", `/projects/${encodeURIComponent(ref)}/api-keys`)).data;
  }

  /** Make an API key for the project's own API. **The key is in the answer once**, as `key`: store it now. Scope `project:write`, role admin. */
  createKey(ref: string, input: CreateKeyInput): Promise<ApiKey & { key: string }> {
    const { environment, allowedIps, allowedRoutes, expiresAt, ...rest } = input;
    return this.c.request("POST", `/projects/${encodeURIComponent(ref)}/api-keys`, {
      query: { environment },
      body: { ...rest, ...(allowedIps ? { allowed_ips: allowedIps } : {}), ...(allowedRoutes ? { allowed_routes: allowedRoutes } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) },
    });
  }

  private async until(ref: string, done: (p: Project) => boolean, options: WaitOptions, check: (p: Project) => void): Promise<Project> {
    const interval = options.interval ?? 2000;
    const deadline = Date.now() + (options.timeout ?? 120_000);
    for (;;) {
      const project = await this.get(ref);
      if (done(project)) {
        check(project);
        return project;
      }
      if (Date.now() + interval > deadline) throw new Error(`Project ${ref} was not ready after ${Math.round((options.timeout ?? 120_000) / 1000)} seconds`);
      if (options.signal?.aborted) throw new Error("Waiting was cancelled");
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

class Marketplace {
  constructor(private readonly c: PawabaseCloud) {}
  /** Every ready-made app. Scope `projects:read`. */
  list(): Promise<MarketplaceApp[]> {
    return this.c.request("GET", "/marketplace");
  }
  /** One app in full, including the variables it asks for. */
  get(slug: string): Promise<MarketplaceApp & { variables?: { name: string; description?: string; default?: string }[] }> {
    return this.c.request("GET", `/marketplace/${encodeURIComponent(slug)}`);
  }
}

/** The targets of a project's server that the Studio API reaches. */
export type StudioTarget = "platform" | "auth" | "realtime" | "telemetry" | "gateway" | "object" | "avatar" | "document";

/**
 * Everything Studio can do inside one project, as plain calls. The answer is the project server's own, unchanged; an error keeps its status
 * and throws {@link CloudError} with the project's own body in `details`.
 *
 * ```ts
 * const project = await pawabase.projects.get(ref);
 * const env = project.default_environment!;
 * const studio = pawabase.studio(ref);
 * await studio.post("platform", `envs/${env}/resources`, { name: "orders", fields: [{ name: "total", type: "number" }] });
 * const tables = await studio.get("platform", `envs/${env}/resources`);
 * ```
 */
export class ProjectStudio {
  constructor(
    private readonly c: PawabaseCloud,
    readonly ref: string,
  ) {}

  request<T = any>(method: string, target: StudioTarget, path: string, options: { body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<T> {
    return this.c.request(method, `/projects/${encodeURIComponent(this.ref)}/studio/${target}/${path.replace(/^\/+/, "")}`, options);
  }
  get<T = any>(target: StudioTarget, path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.request("GET", target, path, { query });
  }
  post<T = any>(target: StudioTarget, path: string, body?: unknown): Promise<T> {
    return this.request("POST", target, path, { body: body ?? {} });
  }
  put<T = any>(target: StudioTarget, path: string, body?: unknown): Promise<T> {
    return this.request("PUT", target, path, { body });
  }
  patch<T = any>(target: StudioTarget, path: string, body?: unknown): Promise<T> {
    return this.request("PATCH", target, path, { body });
  }
  delete<T = any>(target: StudioTarget, path: string): Promise<T> {
    return this.request("DELETE", target, path);
  }
}
