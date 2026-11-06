import { Service, seg, type Api, type Body } from "./base.js";

type When = Date | string;
const iso = (value?: When): string | undefined => (value instanceof Date ? value.toISOString() : value);

/** The environment's API keys: publishable (`pb_pk_…`, safe in apps) and secret (`pb_sk_…`, servers only). */
export class Keys extends Service {
  list(): Promise<Api> {
    return this.get("/keys");
  }

  /** Every scope a key can hold, with what each allows (the choices for `create({ scopes })`). */
  scopes(): Promise<Api> {
    return this.project("GET", "/key-scopes");
  }

  /**
   * Make a key; the key itself is in the answer once. `scopes` limit what it may do (`resource:read`, `routes:invoke`…),
   * `allowedIps` and `allowedRoutes` (`"GET /rest/v1/orders"`, `"/flows/v1/*"`) limit where and what it may call.
   */
  create(name: string, options: { role?: "publishable" | "secret"; scopes?: string[]; expiresAt?: When; allowedIps?: string[]; allowedRoutes?: string[] } = {}): Promise<Api> {
    return this.post("/keys", {
      name,
      role: options.role ?? "publishable",
      scopes: options.scopes ?? [],
      expires_at: iso(options.expiresAt),
      allowed_ips: options.allowedIps ?? [],
      allowed_routes: options.allowedRoutes ?? [],
    });
  }

  revoke(keyId: string): Promise<Api> {
    return this.post(seg("keys", keyId, "revoke"));
  }

  /** Replace a key with a new one; the old keeps working for `graceHours` (24 by default) so clients can switch. */
  rotate(keyId: string, options: { graceHours?: number } = {}): Promise<Api> {
    return this.post(seg("keys", keyId, "rotate"), { grace_hours: options.graceHours ?? 24 });
  }
}

/** Secrets flows read (`ctx.runtime.secret(name)`). Values are never returned. */
export class Secrets extends Service {
  list(): Promise<Api> {
    return this.get("/secrets");
  }

  set(name: string, value: string, options: { description?: string; rotateEveryDays?: number } = {}): Promise<Api> {
    return this.put(seg("secrets", name), { value, description: options.description ?? "", rotate_every_days: options.rotateEveryDays });
  }

  /** Change the description or the rotation reminder (`0` clears it). */
  update(name: string, options: { description?: string; rotateEveryDays?: number }): Promise<Api> {
    return this.patch(seg("secrets", name), { description: options.description, rotate_every_days: options.rotateEveryDays });
  }

  /** Replace the value, keeping the old one for {@link rollback}. */
  rotate(name: string, value?: string): Promise<Api> {
    return this.post(seg("secrets", name, "rotate"), value ? { value } : {});
  }

  /** Put back the value a rotation replaced. */
  rollback(name: string): Promise<Api> {
    return this.post(seg("secrets", name, "rollback"));
  }

  remove(name: string): Promise<Api> {
    return this.del(seg("secrets", name));
  }
}

/** Custom domains the environment answers on, proved with a DNS record. */
export class Domains extends Service {
  list(): Promise<Api> {
    return this.get("/domains");
  }

  /** Register a hostname: the answer says which DNS record proves you own it. */
  add(hostname: string): Promise<Api> {
    return this.post("/domains", { hostname });
  }

  /** Check the DNS record now. */
  verify(domainId: string): Promise<Api> {
    return this.post(seg("domains", domainId, "verify"));
  }

  remove(domainId: string): Promise<Api> {
    return this.del(seg("domains", domainId));
  }
}

export interface FirewallCondition {
  /** `ip`, `country`, `method`, `path`, `host`, `query`, `header:<name>`, `query:<name>`, `user_agent`, `origin`, `referer`, `role`, `key_id`, `content_length`. */
  field: string;
  op: string;
  value: unknown;
}

export interface FirewallRule {
  name: string;
  action?: "allow" | "block" | "log" | "rate_limit";
  conditions?: FirewallCondition[];
  /** How `conditions` combine: `all` (default) or `any`. */
  logic?: "all" | "any";
  match?: Record<string, string[]>;
  rateLimit?: { requests: number; window_seconds: number; by?: string; ban_seconds?: number };
  /** `enforce` (default) or `simulate`, which only records what the rule would have done. */
  mode?: "enforce" | "simulate";
  enabled?: boolean;
  expiresAt?: When;
  note?: string;
}
