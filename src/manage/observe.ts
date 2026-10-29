import { Service, seg, type Api } from "./base.js";

type When = Date | string;
const iso = (value?: When): string | undefined => (value instanceof Date ? value.toISOString() : value);

export class Observability extends Service {
  /** The environment at a glance: traffic, errors, latency, workers, storage. */
  overview(options: { range?: string } = {}): Promise<Api> {
    return this.get("/overview", options);
  }

  /** Traffic over a `range` (`1h`, `24h`, `7d`…) or between `from` and `to`. */
  analytics(options: { range?: string; from?: When; to?: When } = {}): Promise<Api> {
    return this.get("/analytics", { range: options.range, from: iso(options.from), to: iso(options.to) });
  }

  /** Recent requests. `status` is an exact code or a class (`5xx`); `search` matches the path. */
  requests(options: { status?: string; method?: string; search?: string; requestId?: string; limit?: number } = {}): Promise<Api> {
    const { requestId, ...rest } = options;
    return this.get("/requests", { ...rest, request_id: requestId });
  }

  /** One request: its logs, database calls, spans, and the traceback if it failed. */
  request(requestId: string): Promise<Api> {
    return this.get(seg("requests", requestId));
  }

  /** Search application and access logs. `after` continues from the last entry you saw. */
  logs(options: { q?: string; minutes?: number; limit?: number; after?: When } = {}): Promise<Api> {
    return this.get("/logs", { q: options.q || undefined, minutes: options.minutes ?? 60, limit: options.limit ?? 200, after: iso(options.after) });
  }

  errors(options: { minutes?: number } = {}): Promise<Api> {
    return this.get("/observability/errors", options);
  }

  /** Per-route traffic, latency and errors. */
  routes(options: { minutes?: number; limit?: number; sort?: string } = {}): Promise<Api> {
    return this.get("/observability/routes", options);
  }

  route(method: string, route: string, options: { minutes?: number } = {}): Promise<Api> {
    return this.get("/observability/routes/detail", { method, route, ...options });
  }

  /** CPU, memory and connection figures over time. */
  system(options: { minutes?: number } = {}): Promise<Api> {
    return this.get("/observability/system", options);
  }

  /** Findings the platform spotted: slow routes, missing indexes, noisy errors. */
  advisor(options: { minutes?: number } = {}): Promise<Api> {
    return this.get("/advisor", options);
  }

  /** Counters per minute. */
  metrics(options: { name?: string; minutes?: number } = {}): Promise<Api> {
    return this.get("/metrics", options);
  }

  /** The metrics you can chart or alarm on. */
  metricCatalog(): Promise<Api> {
    return this.get("/metric-catalog");
  }

  /** One metric over time; `comparePrevious` adds the span before it. */
  metricSeries(metric = "requests", options: { minutes?: number; period?: number; comparePrevious?: boolean } = {}): Promise<Api> {
    return this.get("/metric-series", { metric, minutes: options.minutes ?? 60, period: options.period, compare: options.comparePrevious ? "previous" : undefined });
  }

  workers(): Promise<Api> {
    return this.get("/workers");
  }

  /** What the environment is running with. */
  configuration(): Promise<Api> {
    return this.get("/configuration");
  }

  capacity(): Promise<Api> {
    return this.get("/capacity");
  }
}

export interface AlarmInput {
  name: string;
  /** A name from {@link Observability.metricCatalog}. */
  metric: string;
  threshold: number;
  comparison?: "gt" | "gte" | "lt" | "lte";
  windowMinutes?: number;
  breachesNeeded?: number;
  recipients?: string[];
  description?: string;
  enabled?: boolean;
  renotifyMinutes?: number;
}

/** Alarms on a metric: when it crosses `threshold` for `breachesNeeded` checks in a row, `recipients` are mailed. */
export class Alarms extends Service {
  list(): Promise<Api> {
    return this.get("/alarms");
  }

  create(alarm: AlarmInput): Promise<Api> {
    return this.post("/alarms", {
      name: alarm.name,
      metric: alarm.metric,
      threshold: alarm.threshold,
      comparison: alarm.comparison ?? "gt",
      window_minutes: alarm.windowMinutes ?? 5,
      breaches_needed: alarm.breachesNeeded ?? 1,
      recipients: alarm.recipients ?? [],
      description: alarm.description ?? "",
      enabled: alarm.enabled ?? true,
      renotify_minutes: alarm.renotifyMinutes ?? 0,
    });
  }

  /** Change some fields, using the server's names (`mute_minutes: 60` silences it for an hour, `0` un-mutes). */
  update(alarmId: string, changes: Record<string, unknown>): Promise<Api> {
    return this.patch(seg("alarms", alarmId), changes);
  }

  remove(alarmId: string): Promise<Api> {
    return this.del(seg("alarms", alarmId));
  }

  /** Evaluate it now. */
  check(alarmId: string): Promise<Api> {
    return this.post(seg("alarms", alarmId, "check"));
  }

  /** Send the notification mail now. */
  test(alarmId: string): Promise<Api> {
    return this.post(seg("alarms", alarmId, "test"));
  }

  /** When alarms fired and recovered: one alarm's, or all. */
  history(alarmId?: string): Promise<Api> {
    return alarmId ? this.get(seg("alarms", alarmId, "events")) : this.get("/alarm-events");
  }
}

export interface StatusComponent {
  name: string;
  /** `gateway`, `api`, `auth`, `realtime`, `workers` (measured) or `manual`. */
  source?: string;
  description?: string;
}

/** The public status page and its incidents. */
export class StatusPage extends Service {
  page(): Promise<Api> {
    return this.get("/status-page");
  }

  configure(options: { enabled?: boolean; title?: string; description?: string; contactUrl?: string; components?: StatusComponent[] } = {}): Promise<Api> {
    return this.put("/status-page", {
      enabled: options.enabled ?? true,
      title: options.title ?? "Status",
      description: options.description ?? "",
      contact_url: options.contactUrl ?? "",
      components: options.components ?? [],
    });
  }

  incidents(): Promise<Api> {
    return this.get("/incidents");
  }

  /** `status`: investigating, identified, monitoring, resolved. `impact`: none, minor, major, critical. */
  openIncident(title: string, options: { message?: string; status?: string; impact?: string; components?: string[] } = {}): Promise<Api> {
    return this.post("/incidents", {
      title,
      message: options.message ?? "",
      status: options.status ?? "investigating",
      impact: options.impact ?? "minor",
      components: options.components ?? [],
    });
  }

  updateIncident(incidentId: string, message: string, options: { status: string; impact?: string }): Promise<Api> {
    return this.post(seg("incidents", incidentId, "updates"), { status: options.status, message, impact: options.impact });
  }

  removeIncident(incidentId: string): Promise<Api> {
    return this.del(seg("incidents", incidentId));
  }
}

export interface AuditFilter {
  action?: string;
  actor?: string;
  target?: string;
  since?: When;
  until?: When;
  env?: string;
}

/** Service health, plan usage and the platform's own audit trail. */
export class Health extends Service {
  /** Each service (database, cache, queue, storage, mail…) with its state, latency and error rate. */
  services(): Promise<Api> {
    return this.get("/service-health");
  }

  /** Each plan limit and how much of it is used. */
  usage(): Promise<Api> {
    return this.get("/plan-usage");
  }

  retryPolicies(): Promise<Api> {
    return this.project("GET", "/retry-policies");
  }

  /** Management-plane changes: who did what, to what, when. */
  audit(filter: AuditFilter = {}): Promise<Api> {
    return this.project("GET", "/audit", { query: { ...filter, since: iso(filter.since), until: iso(filter.until) } });
  }

  /** The audit trail as a file's contents (`jsonl` or `csv`), for the same filters as {@link audit}. */
  exportAudit(filter: AuditFilter & { format?: "jsonl" | "csv" } = {}): Promise<string> {
    return this.project<string>("GET", "/audit/export", { query: { ...filter, format: filter.format ?? "jsonl", since: iso(filter.since), until: iso(filter.until) }, parse: "text" });
  }
}
