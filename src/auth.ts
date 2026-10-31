import { ApiError, AuthenticationError, ConfigError, PawabaseError } from "./errors.js";
import type { HttpClient, TokenProvider } from "./http.js";
import { MemoryStorage, browserStorage, type SessionStorage } from "./session-store.js";
import type {
  AuthSettings,
  Identity,
  Invitation,
  MfaEnrollment,
  MfaStatus,
  OrgMember,
  OrgRole,
  Organization,
  Session,
  SessionInfo,
  SignInEvent,
  Team,
  User,
} from "./types.js";
import { decodeJwt, isRecord, isSecretKey, nowSeconds, queryString, sleep } from "./util.js";

export type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED";

export type AuthListener = (event: AuthChangeEvent, session: Session | null) => unknown;

export interface AuthOptions {
  /**
   * Where the session lives. Default: `localStorage` in a browser, memory elsewhere.
   * Pass your own (React Native's AsyncStorage, a cookie jar…) with `getItem`/`setItem`/`removeItem`.
   */
  storage?: SessionStorage;
  /** Key under which the session is stored. Default: derived from the URL and API key. */
  storageKey?: string;
  /** Keep the session between page loads. Default `true`. `false` keeps it in memory only. */
  persistSession?: boolean;
  /** Refresh the access token shortly before it expires. Default `true`. */
  autoRefreshToken?: boolean;
  /** Seconds before expiry at which the token counts as expiring. Default `60`. */
  refreshMarginSeconds?: number;
  /** Read tokens a social sign-in left in the URL fragment. Default `true` in browsers. */
  detectSessionInUrl?: boolean;
}

export type SignInResult =
  | { status: "signed_in"; session: Session }
  | {
      status: "mfa_required";
      mfaToken: string;
      factors: string[];
      /** Finish the sign-in with an authenticator or recovery code. */
      verify: (code: string) => Promise<Session>;
    };

export interface SignUpResult {
  user: User;
  /** `null` when the address must be confirmed first. */
  session: Session | null;
  verificationRequired: boolean;
}

export type UrlSessionResult =
  | { status: "signed_in"; session: Session }
  | { status: "mfa_required"; mfaToken: string; verify: (code: string) => Promise<Session> }
  | { status: "linked"; provider: string }
  | { status: "error"; error: string }
  | { status: "none" };

export interface UpdateUserInput {
  name?: string;
  avatar_url?: string;
  /** Merged into `user_metadata`. */
  data?: Record<string, unknown>;
  password?: string;
  /** Required when changing the password of an account that has one. */
  current_password?: string;
  /** Starts an email change: a confirmation link goes to the new address. */
  email?: string;
}

interface WireSession extends Omit<Session, "user" | "expires_at"> {
  user?: User;
  expires_at?: number;
}

const LOCK_PREFIX = "pawabase-auth-refresh:";
const FATAL_REFRESH = new Set([400, 401, 403]);

function storageKeyFor(baseUrl: string, apiKey: string): string {
  return `pawabase.auth.${baseUrl.replace(/^https?:\/\//, "")}.${apiKey.slice(0, 14)}`;
}

function toSession(wire: WireSession, user: User | undefined, fallback?: Session | null): Session {
  const issued = nowSeconds();
  const resolved = user ?? wire.user ?? fallback?.user;
  if (!resolved) throw new PawabaseError("The server returned a session without a user.");
  return {
    access_token: wire.access_token,
    refresh_token: wire.refresh_token,
    token_type: "bearer",
    expires_in: wire.expires_in,
    expires_at: wire.expires_at ?? issued + wire.expires_in,
    ...(wire.session_id ? { session_id: wire.session_id } : {}),
    org: wire.org ?? null,
    org_role: wire.org_role ?? null,
    user: resolved,
  };
}

function validSession(value: unknown): value is Session {
  return (
    isRecord(value) &&
    typeof value["access_token"] === "string" &&
    typeof value["refresh_token"] === "string" &&
    typeof value["expires_at"] === "number" &&
    isRecord(value["user"])
  );
}

/**
 * Sign-in, session lifecycle and everything about the signed-in person.
 *
 * The session is kept in storage, refreshed before it expires, and refreshed only
 * once at a time: Akountz rotates refresh tokens and treats a reused one as theft,
 * so two refreshes racing (two requests, or two tabs) would sign the user out.
 * Concurrent callers share one refresh; across tabs the Web Locks API serialises it.
 */
export class AuthClient implements TokenProvider {
  private session: Session | null = null;
  private readonly listeners = new Set<AuthListener>();
  private readonly storage: SessionStorage;
  private readonly persist: boolean;
  private readonly storageKey: string;
  private readonly autoRefresh: boolean;
  private readonly margin: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<Session> | null = null;
  private readonly ready: Promise<void>;
  private disposers: Array<() => void> = [];
  private disposed = false;

  readonly mfa: AuthMfa;
  readonly sessions: AuthSessions;
  readonly orgs: AuthOrgs;
  /** Browsers and apps the user has signed in from. */
  readonly devices: AuthDevices;
  /** Keys a user makes for themselves to call the API as themselves. */
  readonly apiKeys: AuthApiKeys;
  /** Sign a machine (a service or an AI agent) in with its client id and key. */
  readonly machine: AuthMachine;
  /** Passkeys (WebAuthn): register one, sign in with one. */
  readonly passkeys: AuthPasskeys;

  constructor(
    private readonly http: HttpClient,
    private readonly options: AuthOptions & { project?: string | undefined; environment?: string | undefined } = {},
  ) {
    const browser = browserStorage();
    this.persist = options.persistSession ?? true;
    this.storage = options.storage ?? (this.persist && browser ? browser : new MemoryStorage());
    this.storageKey = options.storageKey ?? storageKeyFor(http.config.baseUrl, http.config.apiKey);
    this.autoRefresh = options.autoRefreshToken ?? true;
    this.margin = options.refreshMarginSeconds ?? 60;
    this.mfa = new AuthMfa(http, () => this.refreshSession());
    this.sessions = new AuthSessions(http);
    this.orgs = new AuthOrgs(http);
    this.devices = new AuthDevices(http);
    this.apiKeys = new AuthApiKeys(http);
    this.machine = new AuthMachine(http);
    this.passkeys = new AuthPasskeys(http, (wire) => this.adopt(wire));
    this.ready = this.initialize();
    this.ready.catch(() => undefined);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      const raw = await this.storage.getItem(this.storageKey);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (validSession(parsed)) this.session = parsed;
        else await this.storage.removeItem(this.storageKey);
      }
    } catch {
      await Promise.resolve(this.storage.removeItem(this.storageKey)).catch(() => undefined);
    }
    this.watchOtherTabs();
    const inUrl = (this.options.detectSessionInUrl ?? typeof window !== "undefined") && typeof window !== "undefined";
    if (inUrl && /(?:^#|&)(access_token|error|mfa_required|linked)=/.test(window.location.hash)) {
      const result = await this.getSessionFromUrl().catch(() => ({ status: "none" as const }));
      if (result.status === "signed_in") return;
    }
    if (this.session) this.schedule();
  }

  /** Resolves once the stored session has been read. Everything else awaits it for you. */
  async initialized(): Promise<void> {
    await this.ready;
  }

  /** Stop timers and listeners. Call when discarding a client (tests, hot reload). */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.listeners.clear();
  }

  /**
   * Be told about sign-ins, sign-outs and refreshes (also from other tabs).
   * The listener is called once, soon, with `INITIAL_SESSION`.
   */
  onAuthStateChange(listener: AuthListener): { unsubscribe: () => void } {
    this.listeners.add(listener);
    void this.ready.then(() => {
      if (this.listeners.has(listener)) this.call(listener, "INITIAL_SESSION", this.session);
    });
    return { unsubscribe: () => void this.listeners.delete(listener) };
  }

  private emit(event: AuthChangeEvent): void {
    for (const listener of [...this.listeners]) this.call(listener, event, this.session);
  }

  private call(listener: AuthListener, event: AuthChangeEvent, session: Session | null): void {
    try {
      const result = listener(event, session);
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      /* a listener must not break auth */
    }
  }

  // ── session access ────────────────────────────────────────────────────

  /**
   * The current session, refreshed first when it is about to expire. `null` when signed out.
   * Throws only if the token has already expired and refreshing failed for a reason that
   * may pass (offline, a server error).
   */
  async getSession(): Promise<Session | null> {
    await this.ready;
    const session = this.session;
    if (!session) return null;
    if (!this.expiring(session)) return session;
    try {
      return await this.refreshSession();
    } catch (error) {
      if (!this.session) return null; // the refresh token was refused: signed out
      if (session.expires_at > nowSeconds()) return session; // still valid for now
      throw error;
    }
  }

  /** The access token to send as a bearer, or `null`. */
  async getAccessToken(): Promise<string | null> {
    return (await this.getSession())?.access_token ?? null;
  }

  /** The signed-in user as last known, without a request. */
  async getCachedUser(): Promise<User | null> {
    await this.ready;
    return this.session?.user ?? null;
  }

  /** Called by the transport after a `401`: refresh once, unless someone already did. */
  async onUnauthorized(failed: string): Promise<string | null> {
    await this.ready;
    if (!this.session) return null;
    if (this.session.access_token !== failed) return this.session.access_token;
    try {
      return (await this.refreshSession()).access_token;
    } catch {
      return null;
    }
  }

  private expiring(session: Session): boolean {
    return session.expires_at - this.margin <= nowSeconds();
  }

  /**
   * Adopt a session you obtained elsewhere (a server-side rendered page's cookies,
   * a mobile deep link). Both tokens are required; the user is fetched with them.
   */
  async setSession(tokens: { access_token: string; refresh_token: string }): Promise<Session> {
    await this.ready;
    const claims = decodeJwt(tokens.access_token);
    const exp = typeof claims?.["exp"] === "number" ? claims["exp"] : nowSeconds() + 300;
    const user = await this.http.request<User>({
      path: "/auth/v1/user",
      accessToken: tokens.access_token,
    });
    const session = toSession(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: "bearer",
        expires_in: Math.max(0, exp - nowSeconds()),
        expires_at: exp,
        org: typeof claims?.["org"] === "string" ? claims["org"] : null,
        org_role: typeof claims?.["org_role"] === "string" ? claims["org_role"] : null,
      },
      user,
    );
    await this.store(session, "SIGNED_IN");
    return session;
  }

  private async store(session: Session | null, event: AuthChangeEvent): Promise<void> {
    this.session = session;
    try {
      if (session) await this.storage.setItem(this.storageKey, JSON.stringify(session));
      else await this.storage.removeItem(this.storageKey);
    } catch {
      /* storage can be full or blocked; the in-memory session still works */
    }
    if (session) this.schedule();
    else if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit(event);
  }

  private schedule(): void {
    if (!this.autoRefresh || this.disposed || !this.session) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(1, this.session.expires_at - this.margin - nowSeconds());
    // setTimeout caps at ~24.8 days; tokens last minutes, but be safe.
    const timer = setTimeout(() => {
      void this.refreshSession().catch(() => {
        if (this.session && !this.disposed) {
          this.timer = setTimeout(() => this.schedule(), 10_000);
          (this.timer as { unref?: () => void }).unref?.();
        }
      });
    }, Math.min(wait * 1000, 2 ** 31 - 1));
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private watchOtherTabs(): void {
    if (typeof window === "undefined" || !this.persist) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== this.storageKey) return;
      void (async () => {
        const before = this.session;
        const raw = event.newValue;
        let next: Session | null = null;
        try {
          const parsed: unknown = raw ? JSON.parse(raw) : null;
          next = validSession(parsed) ? parsed : null;
        } catch {
          next = null;
        }
        this.session = next;
        if (next) this.schedule();
        this.emit(!next ? "SIGNED_OUT" : !before ? "SIGNED_IN" : "TOKEN_REFRESHED");
      })();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && this.session && this.expiring(this.session)) {
        void this.refreshSession().catch(() => undefined);
      }
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    this.disposers.push(() => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    });
  }

  // ── refresh ───────────────────────────────────────────────────────────

  /** Exchange the refresh token for a new session. Concurrent calls share one exchange. */
  refreshSession(options: { org?: string | null } = {}): Promise<Session> {
    if (this.inflight && !("org" in options)) return this.inflight;
    const run = this.exclusive(() => this.doRefresh(options));
    const tracked = run.finally(() => {
      if (this.inflight === tracked) this.inflight = null;
    });
    this.inflight = tracked;
    return tracked;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as { navigator?: { locks?: { request<R>(name: string, cb: () => Promise<R>): Promise<R> } } })
      .navigator?.locks;
    if (locks?.request && this.persist && this.storage !== undefined && typeof window !== "undefined") {
      return locks.request(`${LOCK_PREFIX}${this.storageKey}`, fn);
    }
    return fn();
  }

  private async doRefresh(options: { org?: string | null }): Promise<Session> {
    await this.ready;
    let current = this.session;
    // Another tab may have refreshed while we waited for the lock.
    if (this.persist) {
      try {
        const raw = await this.storage.getItem(this.storageKey);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (validSession(parsed) && parsed.refresh_token !== current?.refresh_token) {
          this.session = parsed;
          current = parsed;
          if (!this.expiring(parsed) && !("org" in options)) {
            this.schedule();
            this.emit("TOKEN_REFRESHED");
            return parsed;
          }
        }
      } catch {
        /* fall through to a normal refresh */
      }
    }
    if (!current) throw new AuthenticationError({ status: 401, code: "no_session", message: "Not signed in." });
    try {
      const wire = await this.http.request<WireSession>({
        method: "POST",
        path: "/auth/v1/token",
        body: { grant_type: "refresh_token", refresh_token: current.refresh_token, ...("org" in options ? { org: options.org } : {}) },
        auth: "none",
      });
      const next = toSession(wire, undefined, current);
      await this.store(next, "TOKEN_REFRESHED");
      return next;
    } catch (error) {
      if (error instanceof ApiError && FATAL_REFRESH.has(error.status)) {
        await this.store(null, "SIGNED_OUT");
      }
      throw error;
    }
  }

  // ── sign-in ───────────────────────────────────────────────────────────

  /** What this environment offers: sign-up, magic links, MFA, providers, password rules. */
  settings(): Promise<AuthSettings> {
    return this.http.request({ path: "/auth/v1/settings", auth: "none" });
  }

  /**
   * Create an account. When the project requires email confirmation the result has no
   * session (`verificationRequired` is `true`); otherwise the user is signed in.
   */
  async signUp(input: {
    email: string;
    password: string;
    username?: string;
    name?: string;
    /** Initial `user_metadata`. */
    data?: Record<string, unknown>;
    /** Where the confirmation link sends the user. Must be an allowed redirect URL. */
    redirectTo?: string;
  }): Promise<SignUpResult> {
    const wire = await this.http.request<
      WireSession & { verification_required?: boolean; session?: null; user: User }
    >({
      method: "POST",
      path: "/auth/v1/signup",
      body: {
        email: input.email,
        password: input.password,
        ...(input.username ? { username: input.username } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.data ? { data: input.data } : {}),
        ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}),
      },
      auth: "none",
    });
    if (wire.verification_required || !wire.access_token) {
      return { user: wire.user, session: null, verificationRequired: true };
    }
    const session = toSession(wire, undefined);
    await this.store(session, "SIGNED_IN");
    return { user: session.user, session, verificationRequired: false };
  }

  /**
   * Sign in with email and password. When the account has MFA the result is
   * `{ status: "mfa_required" }`; call its `verify(code)` to finish.
   */
  async signInWithPassword(input: { email: string; password: string; org?: string }): Promise<SignInResult> {
    const wire = await this.http.request<
      (WireSession & { mfa_required?: undefined }) | { mfa_required: true; mfa_token: string; factors: string[] }
    >({
      method: "POST",
      path: "/auth/v1/token",
      body: {
        grant_type: "password",
        email: input.email,
        password: input.password,
        ...(input.org ? { org: input.org } : {}),
      },
      auth: "none",
    });
    if ("mfa_required" in wire && wire.mfa_required) {
      return this.challenge(wire.mfa_token, wire.factors, input.org);
    }
    const session = toSession(wire as WireSession, undefined);
    await this.store(session, "SIGNED_IN");
    return { status: "signed_in", session };
  }

  private challenge(mfaToken: string, factors: string[], org?: string): SignInResult {
    return {
      status: "mfa_required",
      mfaToken,
      factors,
      verify: (code) => this.verifyMfa({ mfaToken, code, ...(org ? { org } : {}) }),
    };
  }

  /** Finish an MFA sign-in with an authenticator code or a recovery code. */
  async verifyMfa(input: { mfaToken: string; code: string; org?: string }): Promise<Session> {
    const wire = await this.http.request<WireSession>({
      method: "POST",
      path: "/auth/v1/token",
      body: {
        grant_type: "mfa",
        mfa_token: input.mfaToken,
        code: input.code,
        ...(input.org ? { org: input.org } : {}),
      },
      auth: "none",
    });
    const session = toSession(wire, undefined);
    await this.store(session, "SIGNED_IN");
    return session;
  }

  /** Email a one-time sign-in link. Always resolves the same way, so it does not reveal whether an account exists. */
  async signInWithMagicLink(input: { email: string; redirectTo?: string; createUser?: boolean }): Promise<void> {
    await this.http.request({
      method: "POST",
      path: "/auth/v1/magic-link",
      body: {
        email: input.email,
        ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}),
        ...(input.createUser !== undefined ? { create_user: input.createUser } : {}),
      },
      auth: "none",
    });
  }

  /** Exchange the token from a magic-link email for a session. */
  async verifyMagicLink(token: string): Promise<SignInResult> {
    const wire = await this.http.request<
      (WireSession & { mfa_required?: undefined }) | { mfa_required: true; mfa_token: string; factors: string[] }
    >({ method: "POST", path: "/auth/v1/magic-link/verify", body: { token }, auth: "none" });
    if ("mfa_required" in wire && wire.mfa_required) return this.challenge(wire.mfa_token, wire.factors);
    const session = toSession(wire as WireSession, undefined);
    await this.store(session, "SIGNED_IN");
    return { status: "signed_in", session };
  }

  /** Keep a session the server just issued and announce it. */
  private async adopt(wire: WireSession): Promise<Session> {
    await this.ready;
    const session = toSession(wire, undefined);
    await this.store(session, "SIGNED_IN");
    return session;
  }

  /**
   * Start a guest session: an account with no email or password, for someone who has not signed up yet. Turn it into a real account with
   * {@link upgradeAnonymous}, keeping everything the guest created. The environment must allow guest sign-in.
   */
  async signInAnonymously(): Promise<Session> {
    const wire = await this.http.request<WireSession>({ method: "POST", path: "/auth/v1/anonymous", body: {}, auth: "none" });
    return this.adopt(wire);
  }

  /** Turn the signed-in guest into a full account. A verification email is sent. */
  async upgradeAnonymous(input: { email: string; password?: string; name?: string; redirectTo?: string }): Promise<{ user: User; verification_sent: boolean }> {
    await this.ready;
    const result = await this.http.request<{ user: User; verification_sent: boolean }>({
      method: "POST",
      path: "/auth/v1/anonymous/upgrade",
      body: {
        email: input.email,
        ...(input.password ? { password: input.password } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}),
      },
    });
    if (this.session) {
      this.session = { ...this.session, user: result.user };
      await Promise.resolve(this.storage.setItem(this.storageKey, JSON.stringify(this.session))).catch(() => undefined);
    }
    this.emit("USER_UPDATED");
    return result;
  }

  /** Email a short sign-in code. The answer is the same whether or not the address has an account. */
  async sendEmailCode(input: { email: string; createUser?: boolean }): Promise<void> {
    await this.http.request({ method: "POST", path: "/auth/v1/email-code", body: { email: input.email, create_user: input.createUser ?? true }, auth: "none" });
  }

  /** Sign in with the code from {@link sendEmailCode}. An account with a second factor answers `mfa_required`. */
  async verifyEmailCode(input: { email: string; code: string }): Promise<SignInResult> {
    const wire = await this.http.request<
      (WireSession & { mfa_required?: undefined }) | { mfa_required: true; mfa_token: string; factors: string[] }
    >({ method: "POST", path: "/auth/v1/email-code/verify", body: { email: input.email, code: input.code }, auth: "none" });
    if ("mfa_required" in wire && wire.mfa_required) return this.challenge(wire.mfa_token, wire.factors);
    const session = await this.adopt(wire as WireSession);
    return { status: "signed_in", session };
  }

  /** The public keys that verify integration tokens ({@link issueToken}), for a server that checks them. */
  async jwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
    const { environment } = this.scope();
    return this.http.request({ path: `/auth/v1/token-keys/${encodeURIComponent(environment)}/jwks`, auth: "none" });
  }

  /**
   * Exchange the signed-in session for a short-lived token for another service, shaped by a token profile you defined in Studio.
   */
  issueToken(profile: string): Promise<IssuedToken> {
    return this.http.request({ method: "POST", path: "/auth/v1/token-profiles/issue", body: { profile } });
  }

  /** Where to send the browser for a social sign-in. Needs `environment` in the client options (or a signed-in session, which names it). */
  signInWithOAuthUrl(provider: string, options: { redirectTo?: string } = {}): string {
    const { environment } = this.scope();
    if (isSecretKey(this.http.config.apiKey)) {
      throw new ConfigError("Refusing to put a secret key in a URL: use a publishable key for social sign-in.");
    }
    const query = queryString({ redirect_to: options.redirectTo, apikey: this.http.config.apiKey });
    return this.http.url(`/auth/v1/authorize/${encodeURIComponent(environment)}/${encodeURIComponent(provider)}`) + query;
  }

  /** Trade the `code` a sign-in redirect carried for a session (pass the verifier of a PKCE `code_challenge` if the sign-in began with one). */
  async exchangeCode(code: string, codeVerifier?: string): Promise<Session> {
    const wire = await this.http.request<WireSession>({
      method: "POST",
      path: "/auth/v1/token/exchange",
      body: { code, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) },
      auth: "none",
    });
    const session = toSession(wire, undefined);
    await this.store(session, "SIGNED_IN");
    return session;
  }

  /** Redirect the browser to a provider. After the round trip, {@link getSessionFromUrl} (run automatically) picks the session up. */
  signInWithOAuth(provider: string, options: { redirectTo?: string } = {}): void {
    if (typeof window === "undefined") {
      throw new ConfigError("signInWithOAuth redirects a browser. On a server, use signInWithOAuthUrl().");
    }
    window.location.assign(this.signInWithOAuthUrl(provider, options));
  }

  private scope(): { environment: string } {
    const claims = this.session ? decodeJwt(this.session.access_token) : null;
    const environment = this.options.environment ?? (typeof claims?.["env"] === "string" ? claims["env"] : undefined);
    if (!environment) {
      throw new ConfigError("Social sign-in needs the environment: pass `environment` to createClient().");
    }
    return { environment };
  }

  /**
   * Read what a social sign-in left in the URL fragment (`#access_token=…`), store the
   * session, and clean the URL. Called automatically in browsers; call it yourself in
   * a mobile deep-link handler.
   */
  async getSessionFromUrl(url?: string): Promise<UrlSessionResult> {
    const target = url ?? (typeof window !== "undefined" ? window.location.href : "");
    const hash = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
    if (!hash) return { status: "none" };
    const params = new URLSearchParams(hash);
    const clean = () => {
      if (url === undefined && typeof window !== "undefined" && window.history?.replaceState) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };
    const error = params.get("error");
    if (error) {
      clean();
      return { status: "error", error };
    }
    const linked = params.get("linked");
    if (linked) {
      clean();
      return { status: "linked", provider: linked };
    }
    if (params.get("mfa_required") && params.get("mfa_token")) {
      clean();
      const mfaToken = params.get("mfa_token") as string;
      return { status: "mfa_required", mfaToken, verify: (code) => this.verifyMfa({ mfaToken, code }) };
    }
    const access = params.get("access_token");
    const refresh = params.get("refresh_token");
    if (!access || !refresh) return { status: "none" };
    clean();
    const session = await this.setSession({ access_token: access, refresh_token: refresh });
    return { status: "signed_in", session };
  }

  // ── session end ───────────────────────────────────────────────────────

  /**
   * Sign out. `local` (default) ends this session, `others` every other one, `global` all of them.
   * The local session is always cleared, even when the server cannot be reached.
   */
  async signOut(options: { scope?: "local" | "global" | "others" } = {}): Promise<void> {
    await this.ready;
    const scope = options.scope ?? "local";
    let failure: unknown = null;
    if (this.session) {
      try {
        await this.http.request({ method: "POST", path: "/auth/v1/logout", body: { scope } });
      } catch (error) {
        // An expired or revoked token already means "signed out" to the server.
        if (!(error instanceof AuthenticationError)) failure = error;
      }
    }
    if (scope !== "others") await this.store(null, "SIGNED_OUT");
    if (failure) throw failure;
  }

  // ── the signed-in user ────────────────────────────────────────────────

  /** The user, fresh from the server (and the session's cached copy is updated). */
  async getUser(): Promise<User> {
    await this.ready;
    const user = await this.http.request<User>({ path: "/auth/v1/user" });
    if (this.session) {
      this.session = { ...this.session, user };
      await Promise.resolve(this.storage.setItem(this.storageKey, JSON.stringify(this.session))).catch(() => undefined);
    }
    return user;
  }

  /** Update the profile, password or (with confirmation) email. */
  async updateUser(input: UpdateUserInput): Promise<User> {
    await this.ready;
    await this.http.request({ method: "PATCH", path: "/auth/v1/user", body: input });
    const user = await this.getUser();
    this.emit("USER_UPDATED");
    return user;
  }

  /** Send the confirmation email again. Always resolves the same way. */
  async resendVerification(input: { email: string; redirectTo?: string }): Promise<void> {
    await this.http.request({
      method: "POST",
      path: "/auth/v1/verify/request",
      body: { email: input.email, ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}) },
      auth: "none",
    });
  }

  /** Confirm an address with the token from the email. Signs the user in. */
  async verifyEmail(token: string): Promise<Session> {
    const wire = await this.http.request<WireSession>({
      method: "POST",
      path: "/auth/v1/verify",
      body: { token },
      auth: "none",
    });
    const session = toSession(wire, undefined);
    await this.store(session, "SIGNED_IN");
    return session;
  }

  /** Confirm a new address with the token from the email. */
  async confirmEmailChange(token: string): Promise<void> {
    await this.http.request({ method: "POST", path: "/auth/v1/email/confirm", body: { token }, auth: "none" });
    if (this.session) await this.getUser().catch(() => undefined);
  }

  /** Email a password reset link. Always resolves the same way. */
  async requestPasswordReset(input: { email: string; redirectTo?: string }): Promise<void> {
    await this.http.request({
      method: "POST",
      path: "/auth/v1/recover",
      body: { email: input.email, ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}) },
      auth: "none",
    });
  }

  /** Set a new password with the token from the reset email. Every other session is ended and this one is signed in. */
  async resetPassword(input: { token: string; password: string }): Promise<Session> {
    const wire = await this.http.request<WireSession>({
      method: "POST",
      path: "/auth/v1/recover/confirm",
      body: { token: input.token, password: input.password },
      auth: "none",
    });
    const session = toSession(wire, undefined);
    await this.store(session, "SIGNED_IN");
    return session;
  }

  // ── identities and organization context ───────────────────────────────

  /** A URL that links a provider to the signed-in account when the browser visits it. */
  async linkIdentityUrl(provider: string, options: { redirectTo?: string } = {}): Promise<string> {
    const result = await this.http.request<{ url: string }>({
      method: "POST",
      path: "/auth/v1/identities/link",
      query: { provider, redirect_to: options.redirectTo },
    });
    return result.url;
  }

  async unlinkIdentity(identityId: number): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/auth/v1/identities/${identityId}` });
    if (this.session) await this.getUser().catch(() => undefined);
  }

  async identities(): Promise<Identity[]> {
    return (await this.getUser()).identities;
  }

  /** Issue tokens for another organization the user belongs to (or `null` for none). */
  switchOrg(slug: string | null): Promise<Session> {
    return this.refreshSession({ org: slug });
  }

  /** Wait `ms` (abortable). Handy in tests. */
  protected pause(ms: number): Promise<void> {
    return sleep(ms);
  }
}

class AuthMfa {
  constructor(
    private readonly http: HttpClient,
    private readonly refresh: () => Promise<Session>,
  ) {}

  status(): Promise<MfaStatus> {
    return this.http.request({ path: "/auth/v1/mfa" });
  }

  /** Start enrolling an authenticator app. Show `otpauth_uri` as a QR code, then call {@link verifyEnrollment}. */
  enroll(): Promise<MfaEnrollment> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/totp/enroll" });
  }

  /** Confirm enrolment with a first code. Returns one-time recovery codes: show them once. */
  async verifyEnrollment(code: string): Promise<{ enabled: boolean; recovery_codes: string[] }> {
    const result = await this.http.request<{ enabled: boolean; recovery_codes: string[] }>({
      method: "POST",
      path: "/auth/v1/mfa/totp/verify",
      body: { code },
    });
    await this.refresh().catch(() => undefined); // the session is now aal2
    return result;
  }

  /** Start using emailed codes as a factor (a code is sent to the account's address). */
  enrollEmail(): Promise<unknown> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/email/enroll" });
  }

  /** Send the emailed code for a sign-in that is waiting on MFA. */
  challenge(mfaToken: string): Promise<unknown> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/challenge", body: { mfa_token: mfaToken }, auth: "none" });
  }

  /** When the environment requires MFA, a sign-in is held until a factor is set up: start it (`totp` or `email`). */
  startSetup(input: { mfaToken: string; method: "totp" | "email" }): Promise<unknown> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/setup/start", body: { mfa_token: input.mfaToken, method: input.method }, auth: "none" });
  }

  /** Finish the required setup with a first code: the response carries the session and the recovery codes. */
  completeSetup(input: { mfaToken: string; code: string; org?: string }): Promise<{ recovery_codes?: string[]; access_token?: string }> {
    return this.http.request({
      method: "POST",
      path: "/auth/v1/mfa/setup/complete",
      body: { mfa_token: input.mfaToken, code: input.code, ...(input.org ? { org: input.org } : {}) },
      auth: "none",
    });
  }

  disable(code: string): Promise<{ enabled: boolean }> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/disable", body: { code } });
  }

  /** Replace the recovery codes. Needs a current authenticator code. */
  regenerateRecoveryCodes(code: string): Promise<{ recovery_codes: string[] }> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/recovery-codes", body: { code } });
  }
}

export interface IssuedToken {
  token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  audience: string;
}

export interface Passkey {
  id: string;
  name: string;
  device_type: string;
  backed_up: boolean;
  transports: string[];
  created_at: string;
  last_used_at: string | null;
}

/** What the server asks the device to do, and the ticket that ties the answer back to the request. */
export interface PasskeyChallenge {
  ticket: string;
  options: Record<string, unknown>;
}

const b64uToBytes = (value: string): ArrayBuffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
};

const bytesToB64u = (buffer: ArrayBuffer | ArrayBufferView): string => {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function webauthn(): CredentialsContainer {
  if (typeof navigator === "undefined" || !navigator.credentials || typeof PublicKeyCredential === "undefined") {
    throw new ConfigError("Passkeys need a browser that supports WebAuthn. On a server, use `requestRegistration` / `requestSignIn` and carry the credential yourself.");
  }
  return navigator.credentials;
}

/**
 * Passkeys. In a browser, {@link register} and {@link signIn} do the whole ceremony. Anywhere else (a native app, a test), use the
 * `request…` and `finish…` pairs: hand `options` to the platform's WebAuthn, and send what it returns (already encoded as the
 * server expects) back with the `ticket`.
 */
class AuthPasskeys {
  constructor(
    private readonly http: HttpClient,
    private readonly adopt: (wire: WireSession) => Promise<Session>,
  ) {}

  async list(): Promise<Passkey[]> {
    const body = await this.http.request<{ data: Passkey[] }>({ path: "/auth/v1/passkeys" });
    return body.data;
  }

  async remove(passkeyId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/auth/v1/passkeys/${encodeURIComponent(passkeyId)}` });
  }

  /** Begin adding a passkey to the signed-in account. */
  requestRegistration(): Promise<PasskeyChallenge> {
    return this.http.request({ method: "POST", path: "/auth/v1/passkeys/register/options", body: {} });
  }

  /** Finish adding a passkey with the credential the device made. */
  finishRegistration(input: { ticket: string; credential: Record<string, unknown>; name?: string }): Promise<{ passkey: Passkey }> {
    return this.http.request({
      method: "POST",
      path: "/auth/v1/passkeys/register/verify",
      body: { ticket: input.ticket, credential: input.credential, ...(input.name ? { name: input.name } : {}) },
    });
  }

  /** Begin signing in with a passkey. With an email, only that account's passkeys are offered. */
  requestSignIn(input: { email?: string } = {}): Promise<PasskeyChallenge> {
    return this.http.request({ method: "POST", path: "/auth/v1/passkeys/authenticate/options", body: input.email ? { email: input.email } : {}, auth: "none" });
  }

  /** Finish signing in with the credential the device made. */
  async finishSignIn(input: { ticket: string; credential: Record<string, unknown> }): Promise<Session> {
    const wire = await this.http.request<WireSession>({
      method: "POST",
      path: "/auth/v1/passkeys/authenticate/verify",
      body: { ticket: input.ticket, credential: input.credential },
      auth: "none",
    });
    return this.adopt(wire);
  }

  /** In a browser: ask the device to make a passkey and add it to the signed-in account. */
  async register(input: { name?: string } = {}): Promise<Passkey> {
    const credentials = webauthn();
    const { ticket, options } = await this.requestRegistration();
    const publicKey = {
      ...options,
      challenge: b64uToBytes(String(options.challenge)),
      user: { ...(options.user as Record<string, unknown>), id: new TextEncoder().encode(String((options.user as Record<string, unknown>).id)) },
      excludeCredentials: ((options.excludeCredentials as Array<Record<string, string>> | undefined) ?? []).map((c) => ({ ...c, id: b64uToBytes(c.id as string) })),
    } as unknown as PublicKeyCredentialCreationOptions;
    const made = (await credentials.create({ publicKey })) as PublicKeyCredential | null;
    if (!made) throw new PawabaseError("No passkey was made.");
    const response = made.response as AuthenticatorAttestationResponse;
    const result = await this.finishRegistration({
      ticket,
      ...(input.name ? { name: input.name } : {}),
      credential: {
        id: made.id,
        rawId: bytesToB64u(made.rawId),
        type: made.type,
        response: {
          clientDataJSON: bytesToB64u(response.clientDataJSON),
          attestationObject: bytesToB64u(response.attestationObject),
          transports: typeof response.getTransports === "function" ? response.getTransports() : [],
        },
        clientExtensionResults: made.getClientExtensionResults(),
      },
    });
    return result.passkey;
  }

  /** In a browser: ask the device for a passkey and sign in with it. */
  async signIn(input: { email?: string } = {}): Promise<Session> {
    const credentials = webauthn();
    const { ticket, options } = await this.requestSignIn(input);
    const publicKey = {
      ...options,
      challenge: b64uToBytes(String(options.challenge)),
      allowCredentials: ((options.allowCredentials as Array<Record<string, string>> | undefined) ?? []).map((c) => ({ ...c, id: b64uToBytes(c.id as string) })),
    } as unknown as PublicKeyCredentialRequestOptions;
    const got = (await credentials.get({ publicKey })) as PublicKeyCredential | null;
    if (!got) throw new PawabaseError("No passkey was chosen.");
    const response = got.response as AuthenticatorAssertionResponse;
    return this.finishSignIn({
      ticket,
      credential: {
        id: got.id,
        rawId: bytesToB64u(got.rawId),
        type: got.type,
        response: {
          clientDataJSON: bytesToB64u(response.clientDataJSON),
          authenticatorData: bytesToB64u(response.authenticatorData),
          signature: bytesToB64u(response.signature),
          userHandle: response.userHandle ? bytesToB64u(response.userHandle) : null,
        },
        clientExtensionResults: got.getClientExtensionResults(),
      },
    });
  }
}

class AuthSessions {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<SessionInfo[]> {
    return (await this.http.request<{ data: SessionInfo[] }>({ path: "/auth/v1/sessions" })).data;
  }

  /** Sign one session out (a lost phone, another browser). */
  async revoke(sessionId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/auth/v1/sessions/${encodeURIComponent(sessionId)}` });
  }

  /** Recent sign-in activity for the account. */
  async history(): Promise<SignInEvent[]> {
    return (await this.http.request<{ data: SignInEvent[] }>({ path: "/auth/v1/history" })).data;
  }
}

class AuthDevices {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Array<Record<string, unknown>>> {
    const body = await this.http.request<{ data?: Array<Record<string, unknown>> }>({ path: "/auth/v1/user/devices" });
    return body.data ?? [];
  }

  async forget(deviceId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/auth/v1/user/devices/${encodeURIComponent(deviceId)}` });
  }
}

/** What a machine gets for its credentials. */
export interface MachineToken {
  accessToken: string;
  tokenType: "Bearer";
  /** Seconds the token lives. */
  expiresIn: number;
  /** The permissions the token carries, space-separated. */
  scope: string;
  machine: { id: string; name: string; kind: "service" | "agent" };
}

class AuthMachine {
  constructor(private readonly http: HttpClient) {}

  /**
   * The OAuth `client_credentials` grant: exchange a machine's id and one of its keys (`pbm_…`) for a short-lived access token.
   * `scope` (space-separated permissions) asks for fewer permissions than the key allows; it never grants more. Keeps no session.
   */
  async token(input: { clientId: string; clientSecret: string; scope?: string }): Promise<MachineToken> {
    const wire = await this.http.request<{
      access_token: string;
      token_type: "Bearer";
      expires_in: number;
      scope: string;
      machine: MachineToken["machine"];
    }>({
      method: "POST",
      path: "/auth/v1/token",
      body: {
        grant_type: "client_credentials",
        client_id: input.clientId,
        client_secret: input.clientSecret,
        ...(input.scope ? { scope: input.scope } : {}),
      },
      auth: "none",
    });
    return { accessToken: wire.access_token, tokenType: wire.token_type, expiresIn: wire.expires_in, scope: wire.scope, machine: wire.machine };
  }
}

class AuthApiKeys {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Array<Record<string, unknown>>> {
    const body = await this.http.request<{ data?: Array<Record<string, unknown>> }>({ path: "/auth/v1/user/api-keys" });
    return body.data ?? [];
  }

  /** Make a key. The secret is in the answer once and never again. */
  create(input: { name: string; scopes?: string[]; expiresInDays?: number; org?: string }): Promise<{ secret?: string } & Record<string, unknown>> {
    return this.http.request({
      method: "POST",
      path: "/auth/v1/user/api-keys",
      body: { name: input.name, scopes: input.scopes ?? [], ...(input.expiresInDays ? { expires_in_days: input.expiresInDays } : {}), ...(input.org ? { org: input.org } : {}) },
    });
  }

  async revoke(keyId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/auth/v1/user/api-keys/${encodeURIComponent(keyId)}` });
  }
}

class AuthOrgs {
  constructor(private readonly http: HttpClient) {}

  private base(slug: string): string {
    return `/auth/v1/orgs/${encodeURIComponent(slug)}`;
  }

  async list(): Promise<Organization[]> {
    return (await this.http.request<{ data: Organization[] }>({ path: "/auth/v1/orgs" })).data;
  }
  create(input: { slug: string; name: string; metadata?: Record<string, unknown> }): Promise<Organization> {
    return this.http.request({ method: "POST", path: "/auth/v1/orgs", body: input });
  }
  get(slug: string): Promise<Organization> {
    return this.http.request({ path: this.base(slug) });
  }
  update(slug: string, input: { name?: string; metadata?: Record<string, unknown> }): Promise<Organization> {
    return this.http.request({ method: "PATCH", path: this.base(slug), body: input });
  }
  async delete(slug: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: this.base(slug) });
  }

  async members(slug: string): Promise<OrgMember[]> {
    return (await this.http.request<{ data: OrgMember[] }>({ path: `${this.base(slug)}/members` })).data;
  }
  setMemberRole(slug: string, userId: string, role: OrgRole): Promise<unknown> {
    return this.http.request({ method: "PUT", path: `${this.base(slug)}/members/${encodeURIComponent(userId)}`, body: { role } });
  }
  async removeMember(slug: string, userId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `${this.base(slug)}/members/${encodeURIComponent(userId)}` });
  }

  invite(slug: string, input: { email: string; role?: OrgRole; redirectTo?: string }): Promise<Invitation> {
    return this.http.request({
      method: "POST",
      path: `${this.base(slug)}/invitations`,
      body: {
        email: input.email,
        role: input.role ?? "member",
        ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}),
      },
    });
  }
  async invitations(slug: string): Promise<Invitation[]> {
    return (await this.http.request<{ data: Invitation[] }>({ path: `${this.base(slug)}/invitations` })).data;
  }
  async revokeInvitation(slug: string, invitationId: number): Promise<void> {
    await this.http.request({ method: "DELETE", path: `${this.base(slug)}/invitations/${invitationId}` });
  }
  /** Accept an invitation with the token from the email. The user must be signed in. */
  acceptInvitation(token: string): Promise<unknown> {
    return this.http.request({ method: "POST", path: "/auth/v1/invitations/accept", body: { token } });
  }

  async teams(slug: string): Promise<Team[]> {
    return (await this.http.request<{ data: Team[] }>({ path: `${this.base(slug)}/teams` })).data;
  }
  createTeam(slug: string, input: { slug: string; name: string }): Promise<Team> {
    return this.http.request({ method: "POST", path: `${this.base(slug)}/teams`, body: input });
  }
  async addTeamMember(slug: string, team: string, userId: string): Promise<void> {
    await this.http.request({
      method: "PUT",
      path: `${this.base(slug)}/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(userId)}`,
    });
  }
  async removeTeamMember(slug: string, team: string, userId: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `${this.base(slug)}/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(userId)}`,
    });
  }
}

export type { AuthMfa, AuthSessions, AuthOrgs };
