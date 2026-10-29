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
   * Make a key; the key itself is in the answer once. `scopes` limit what it may do (`resource:read`, `functions:invoke`…),
   * `allowedIps` and `allowedRoutes` (`"GET /rest/v1/orders"`, `"/functions/v1/*"`) limit where and what it may call.
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

/** Secrets functions and flows read (`ctx.runtime.secret(name)`). Values are never returned. */
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

/**
 * The firewall at the gateway: ordered rules (allow, block, log, rate limit), managed attack signatures, bans, and what it did.
 *
 * ```ts
 * await m.firewall.addRule({ name: "Burst", action: "rate_limit",
 *   conditions: [{ field: "path", op: "starts_with", value: "/auth/v1/token" }],
 *   rateLimit: { requests: 10, window_seconds: 60, by: "ip", ban_seconds: 900 } });
 * ```
 */
export class Firewall extends Service {
  /** Rules in the order they are tried. */
  rules(): Promise<Api> {
    return this.get("/firewall");
  }

  /** Add a rule at the end. */
  addRule(rule: FirewallRule): Promise<Api> {
    return this.post("/firewall", {
      name: rule.name,
      action: rule.action ?? "block",
      conditions: rule.conditions ?? [],
      logic: rule.logic ?? "all",
      match: rule.match ?? {},
      rate_limit: rule.rateLimit,
      mode: rule.mode ?? "enforce",
      enabled: rule.enabled ?? true,
      expires_at: iso(rule.expiresAt),
      note: rule.note ?? "",
    });
  }

  /** Change some fields of a rule, using the server's field names (`clear_expiry: true` removes an expiry). */
  updateRule(ruleId: string, changes: Body): Promise<Api> {
    return this.patch(seg("firewall", ruleId), changes);
  }

  removeRule(ruleId: string): Promise<Api> {
    return this.del(seg("firewall", ruleId));
  }

  /** Set the order rules are tried in: every rule exactly once. */
  order(ruleIds: string[]): Promise<Api> {
    return this.put("/firewall-order", { ids: ruleIds });
  }

  /** Managed rule sets (`sqli`, `xss`, `traversal`, `scanners`, `sensitive_files`, `no_user_agent`, `methods`) and automatic bans. */
  config(): Promise<Api> {
    return this.get("/firewall-config");
  }

  /** `managed`: `{ sqli: "block", scanners: "log" }` (`off`, `log`, `block`). `autoBan`: `{ enabled, threshold, window_seconds, ban_seconds, statuses, exempt }`. */
  setConfig(options: { managed?: Record<string, string>; autoBan?: Body }): Promise<Api> {
    return this.put("/firewall-config", { managed: options.managed, auto_ban: options.autoBan });
  }

  bans(options: { includeExpired?: boolean } = {}): Promise<Api> {
    return this.get("/firewall-bans", { all: options.includeExpired ? 1 : undefined });
  }

  /** Ban an address or CIDR range for `seconds` (`0`: until lifted). */
  ban(ip: string, options: { seconds?: number; reason?: string } = {}): Promise<Api> {
    return this.post("/firewall-bans", { ip, seconds: options.seconds ?? 0, reason: options.reason ?? "" });
  }

  liftBan(banId: string): Promise<Api> {
    return this.del(seg("firewall-bans", banId));
  }

  events(options: { action?: string; source?: string; ip?: string; path?: string; ruleId?: string; limit?: number } = {}): Promise<Api> {
    const { ruleId, ...rest } = options;
    return this.get("/firewall-events", { limit: 100, ...rest, rule_id: ruleId });
  }

  /** Totals, a timeline, and the top addresses, paths, rules and countries. */
  stats(options: { hours?: number } = {}): Promise<Api> {
    return this.get("/firewall-stats", { hours: options.hours ?? 24 });
  }

  /** What the firewall would do with a request, step by step. Nothing is sent or counted. */
  test(ip: string, options: { path?: string; method?: string; userAgent?: string; query?: string; headers?: Record<string, string>; country?: string; role?: string } = {}): Promise<Api> {
    return this.post("/firewall-test", {
      ip,
      path: options.path ?? "/",
      method: options.method ?? "GET",
      user_agent: options.userAgent ?? "",
      query: options.query ?? "",
      headers: options.headers ?? {},
      country: options.country ?? "",
      role: options.role ?? "none",
    });
  }
}
