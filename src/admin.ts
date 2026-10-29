/**
 * Administer the environment's users, organizations and roles, with the environment's secret key (`pb_sk_…`).
 *
 * These are the people who sign in to *your* application, not the project's own team. Every call is scoped to one environment;
 * a user of one environment is never visible in another.
 *
 * ```ts
 * import { createClient } from "@pawabase/client";
 * import { admin } from "@pawabase/client/admin";
 *
 * const a = admin(createClient({ url, apiKey: "pb_sk_…", environment: "production" }));
 * await a.users.create({ email: "ada@example.com", password: "…", roles: ["editor"] });
 * await a.users.update(userId, { disabled: true });
 * await a.orgs.addMember("acme", { email: "ada@example.com", role: "admin" });
 * ```
 */
import type { PawabaseClient } from "./client.js";
import { ConfigError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { Service, seg, type Api, type Body } from "./manage/base.js";
import { isSecretKey } from "./util.js";

class AdminService extends Service {
  protected override path(suffix = ""): string {
    return `/platform/v1/envs/${encodeURIComponent(this.environment)}/auth${suffix}`;
  }
}

export interface NewUser {
  email: string;
  password?: string;
  username?: string;
  name?: string;
  /** Default `true`: an operator vouches for the address. */
  emailVerified?: boolean;
  /** Visible to the user and editable by them. */
  userMetadata?: Body;
  /** Visible to your server only. */
  appMetadata?: Body;
  roles?: string[];
}

export interface UserChanges {
  name?: string;
  emailVerified?: boolean;
  /** Blocks sign-in and ends the user's sessions. */
  disabled?: boolean;
  password?: string;
  userMetadata?: Body;
  appMetadata?: Body;
  /** Replaces the user's roles. */
  roles?: string[];
  /** Clears a lockout after failed sign-ins. */
  unlock?: boolean;
}

export class Users extends AdminService {
  /** `search` matches email, username and name. `status`: `disabled`, `unverified`, `locked`, `mfa`, `no_mfa`. */
  search(options: { search?: string; status?: string; limit?: number; offset?: number } = {}): Promise<Api> {
    return this.get("/users", { limit: 50, offset: 0, ...options });
  }

  getUser(userId: string): Promise<Api> {
    return this.get(seg("users", userId));
  }

  /** Create an account without the sign-up restrictions (allow-lists; the password policy still applies). */
  create(user: NewUser): Promise<Api> {
    return this.post("/users", {
      email: user.email,
      password: user.password,
      username: user.username,
      name: user.name ?? "",
      email_verified: user.emailVerified ?? true,
      user_metadata: user.userMetadata ?? {},
      app_metadata: user.appMetadata ?? {},
      roles: user.roles ?? [],
    });
  }

  update(userId: string, changes: UserChanges): Promise<Api> {
    return this.patch(seg("users", userId), {
      name: changes.name,
      email_verified: changes.emailVerified,
      disabled: changes.disabled,
      password: changes.password,
      user_metadata: changes.userMetadata,
      app_metadata: changes.appMetadata,
      roles: changes.roles,
      unlock: changes.unlock,
    });
  }

  deleteUser(userId: string): Promise<Api> {
    return this.del(seg("users", userId));
  }

  /** The user's recent sign-ins and security events. */
  history(userId: string): Promise<Api> {
    return this.get(seg("users", userId, "history"));
  }

  /** Remove the user's second factors, so they can sign in with a password alone and enrol again. */
  resetMfa(userId: string): Promise<Api> {
    return this.post(seg("users", userId, "mfa", "reset"));
  }

  /** Give the user permissions directly, beyond their roles' (`posts:write`, `billing:*`). */
  grant(userId: string, permissions: string[]): Promise<Api> {
    return this.post(seg("users", userId, "permissions"), { permissions });
  }

  revoke(userId: string, permissions: string[]): Promise<Api> {
    return this.del(seg("users", userId, "permissions"), undefined, { permissions });
  }

  /** Sign the user out everywhere. */
  revokeSessions(userId: string): Promise<Api> {
    return this.post(seg("users", userId, "sessions", "revoke"));
  }

  revokeSession(userId: string, sessionId: string): Promise<Api> {
    return this.del(seg("users", userId, "sessions", sessionId));
  }

  devices(userId: string): Promise<Api> {
    return this.get(seg("users", userId, "devices"));
  }

  forgetDevice(userId: string, deviceId: string): Promise<Api> {
    return this.del(seg("users", userId, "devices", deviceId));
  }

  /** The user's own API keys (never the secrets). */
  apiKeys(userId: string): Promise<Api> {
    return this.get(seg("users", userId, "api-keys"));
  }
}

export class Roles extends AdminService {
  /** Roles with their permissions. */
  list(): Promise<Api> {
    return this.get("/roles");
  }

  /** Create or replace a role. Names are lowercase (`editor`, `org:billing`); permissions are `resource:action` patterns with `*` wildcards. */
  define(name: string, permissions: string[], options: { description?: string } = {}): Promise<Api> {
    return this.put("/roles", { name, description: options.description ?? "", permissions });
  }

  remove(name: string): Promise<Api> {
    return this.del(seg("roles", name));
  }
}

/** Organizations (tenants) and their members. A member's role is `owner`, `admin` or `member`. */
export class Orgs extends AdminService {
  list(): Promise<Api> {
    return this.get("/orgs");
  }

  getOrg(slug: string): Promise<Api> {
    return this.get(seg("orgs", slug));
  }

  create(slug: string, name: string, options: { ownerEmail?: string; metadata?: Body } = {}): Promise<Api> {
    return this.post("/orgs", { slug, name, owner_email: options.ownerEmail, metadata: options.metadata ?? {} });
  }

  update(slug: string, changes: { name?: string; metadata?: Body }): Promise<Api> {
    return this.patch(seg("orgs", slug), changes);
  }

  remove(slug: string): Promise<Api> {
    return this.del(seg("orgs", slug));
  }

  /** Add an existing user straight in. */
  addMember(slug: string, member: { email: string; role?: string }): Promise<Api> {
    return this.post(seg("orgs", slug, "members"), { email: member.email, role: member.role ?? "member" });
  }

  setMemberRole(slug: string, userId: string, role: string): Promise<Api> {
    return this.patch(seg("orgs", slug, "members", userId), { role });
  }

  removeMember(slug: string, userId: string): Promise<Api> {
    return this.del(seg("orgs", slug, "members", userId));
  }

  /** Mail an invitation; `redirectTo` must be one of the environment's allowed redirect URLs. */
  invite(slug: string, invitation: { email: string; role?: string; redirectTo?: string }): Promise<Api> {
    return this.post(seg("orgs", slug, "invitations"), { email: invitation.email, role: invitation.role ?? "member", redirect_to: invitation.redirectTo });
  }
}

export class Invitations extends AdminService {
  /** Pending and past invitations across organizations. */
  list(): Promise<Api> {
    return this.get("/invitations");
  }

  resend(invitationId: string, options: { redirectTo?: string } = {}): Promise<Api> {
    return this.post(seg("invitations", invitationId, "resend"), options.redirectTo ? { redirect_to: options.redirectTo } : {});
  }

  revoke(invitationId: string): Promise<Api> {
    return this.del(seg("invitations", invitationId));
  }
}

export class Sessions extends AdminService {
  /** Active sessions across users. */
  list(options: { limit?: number } = {}): Promise<Api> {
    return this.get("/sessions", options);
  }

  /** End one session (all its refresh tokens). */
  revoke(family: string): Promise<Api> {
    return this.del(seg("sessions", family));
  }
}

/** API keys users made for themselves. */
export class ApiKeys extends AdminService {
  list(options: { limit?: number } = {}): Promise<Api> {
    return this.get("/api-keys", options);
  }

  revoke(keyId: string): Promise<Api> {
    return this.del(seg("api-keys", keyId));
  }
}

export class Devices extends AdminService {
  /** Recent devices people signed in from. */
  list(options: { limit?: number } = {}): Promise<Api> {
    return this.get("/devices", options);
  }
}

/** Events, statistics, identity backup and the hosted pages. */
export class Insight extends AdminService {
  /** Authentication events (sign-ins, sign-ups, resets, MFA…). `failed` for failures only. */
  events(options: { kind?: string; failed?: boolean; limit?: number } = {}): Promise<Api> {
    return this.get("/events", { kind: options.kind, failed: options.failed ? "true" : undefined, limit: options.limit ?? 100 });
  }

  /** Counts of users, sign-ins, MFA use and failures. */
  stats(): Promise<Api> {
    return this.get("/stats");
  }

  /** Every identity (users, organizations, roles, factors) as a document. */
  backup(): Promise<Api> {
    return this.get("/backup");
  }

  /** Apply the `identities` of a backup. `dryRun` reports what would change. */
  restore(identities: Body, options: { replace?: boolean; dryRun?: boolean } = {}): Promise<Api> {
    return this.post("/restore", { identities, replace: options.replace ?? false, dry_run: options.dryRun ?? false });
  }

  /** The HTML a hosted sign-in page is served as for the branding being edited (the saved branding when omitted). */
  /** The claims a token profile would put in a token for this user (and organization), without issuing one. */
  previewTokenProfile(profile: Body, userId: string, options: { org?: string } = {}): Promise<Api> {
    return this.post("/token-profiles/preview", { profile, user_id: userId, ...(options.org ? { org: options.org } : {}) });
  }

  hostedSource(page: string, options: { branding?: Body; form?: Body } = {}): Promise<Api> {
    return this.post("/hosted-source", { page, branding: options.branding, form: options.form });
  }
}

export class Admin {
  readonly users: Users;
  readonly roles: Roles;
  readonly orgs: Orgs;
  readonly invitations: Invitations;
  readonly sessions: Sessions;
  readonly apiKeys: ApiKeys;
  readonly devices: Devices;
  readonly insight: Insight;

  constructor(
    private readonly http: HttpClient,
    readonly environment: string,
  ) {
    this.users = new Users(http, environment);
    this.roles = new Roles(http, environment);
    this.orgs = new Orgs(http, environment);
    this.invitations = new Invitations(http, environment);
    this.sessions = new Sessions(http, environment);
    this.apiKeys = new ApiKeys(http, environment);
    this.devices = new Devices(http, environment);
    this.insight = new Insight(http, environment);
  }

  /** The same services for another environment the key may manage. */
  withEnvironment(name: string): Admin {
    return new Admin(this.http, name);
  }
}

/** User administration for the client's environment (or `environment`). Needs a secret key. */
export function admin(client: PawabaseClient<any>, environment?: string): Admin {
  if (!isSecretKey(client.options.apiKey)) {
    throw new ConfigError("User administration needs a secret key (pb_sk_…).");
  }
  return new Admin(client.http, environment ?? client.options.environment ?? "development");
}
