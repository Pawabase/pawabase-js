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
import { decodeJwt, isRecord, nowSeconds, queryString, sleep } from "./util.js";

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

  /** Where to send the browser for a social sign-in. Needs `project` and `environment` in the client options. */
  signInWithOAuthUrl(provider: string, options: { redirectTo?: string } = {}): string {
    const { project, environment } = this.scope();
    const query = queryString({ redirect_to: options.redirectTo, apikey: this.http.config.apiKey });
    return this.http.url(`/auth/v1/authorize/${encodeURIComponent(project)}/${encodeURIComponent(environment)}/${encodeURIComponent(provider)}`) + query;
  }

  /** Redirect the browser to a provider. After the round trip, {@link getSessionFromUrl} (run automatically) picks the session up. */
  signInWithOAuth(provider: string, options: { redirectTo?: string } = {}): void {
    if (typeof window === "undefined") {
      throw new ConfigError("signInWithOAuth redirects a browser. On a server, use signInWithOAuthUrl().");
    }
    window.location.assign(this.signInWithOAuthUrl(provider, options));
  }

  private scope(): { project: string; environment: string } {
    const claims = this.session ? decodeJwt(this.session.access_token) : null;
    const project = this.options.project ?? (typeof claims?.["prj"] === "string" ? claims["prj"] : undefined);
    const environment = this.options.environment ?? (typeof claims?.["env"] === "string" ? claims["env"] : undefined);
    if (!project || !environment) {
      throw new ConfigError(
        "Social sign-in needs the project and environment: pass `project` and `environment` to createClient().",
      );
    }
    return { project, environment };
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

  disable(code: string): Promise<{ enabled: boolean }> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/disable", body: { code } });
  }

  /** Replace the recovery codes. Needs a current authenticator code. */
  regenerateRecoveryCodes(code: string): Promise<{ recovery_codes: string[] }> {
    return this.http.request({ method: "POST", path: "/auth/v1/mfa/recovery-codes", body: { code } });
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
