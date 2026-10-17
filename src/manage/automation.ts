import { Definitions, Service, seg, type Api, type Body } from "./base.js";

/** Flows: graphs of blocks that run on a trigger (HTTP, event, schedule, resource change, webhook, manual). */
export class Flows extends Definitions {
  protected override readonly kind = "flows";

  /** Run a flow now as an operator (or `asUser`): `{ status, run_id, result, response, trace }`. `entry` picks a trigger node. */
  run(name: string, input?: unknown, options: { asUser?: Body; entry?: string } = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "run"), { input, as_user: options.asUser ?? null, entry: options.entry ?? null });
  }

  /** Check a flow's graph without saving it: the problems, node by node. */
  validate(definition: Body): Promise<Api> {
    return this.project("POST", "/flows/validate", { body: { definition } });
  }

  /** The catalogue of blocks a flow can use, with their configuration fields. */
  blocks(): Promise<Api> {
    return this.project("GET", "/blocks");
  }

  runs(options: { flow?: string; status?: string; limit?: number; after?: string } = {}): Promise<Api> {
    return this.get("/flow-runs", options);
  }

  /** One run with its per-block trace. */
  runDetail(runId: string): Promise<Api> {
    return this.get(seg("flow-runs", runId));
  }
}

/** Cron and interval schedules that run a flow or function, or emit an event. */
export class Schedules extends Definitions {
  protected override readonly kind = "schedules";

  /** Fire a schedule now, exactly as the scheduler would. */
  run(name: string): Promise<Api> {
    return this.post(seg(this.kind, name, "run"));
  }
}

/** Event subscriptions: which events run which flow or function, or reach which realtime channel. */
export class Subscriptions extends Definitions {
  protected override readonly kind = "subscriptions";
}

/** The event bus: emit, and inspect what happened to each event. */
export class Events extends Service {
  /** Publish an event: every subscription, flow and webhook listening for it runs. */
  emit(name: string, payload?: unknown): Promise<Api> {
    return this.post("/events", { name, payload });
  }

  list(options: { name?: string; limit?: number; after?: string } = {}): Promise<Api> {
    return this.get("/events", options);
  }

  /** One event with every consumer it reached and how that went. */
  detail(eventId: string): Promise<Api> {
    return this.get(seg("events", eventId));
  }

  /** Which event names exist and who consumes each. */
  graph(): Promise<Api> {
    return this.get("/events-graph");
  }
}

/** Outbound webhooks: endpoints that receive signed events, with retries. */
export class Webhooks extends Definitions {
  protected override readonly kind = "webhooks";

  /** Send one test event to an endpoint (one attempt, not retried). */
  test(name: string): Promise<Api> {
    return this.post(seg(this.kind, name, "test"));
  }

  /** Delivery history. `status`: `pending`, `retrying`, `delivered`, `failed`. */
  deliveries(options: { status?: string; endpoint?: string; limit?: number } = {}): Promise<Api> {
    return this.get("/webhook-deliveries", options);
  }

  redeliver(deliveryId: string): Promise<Api> {
    return this.post(seg("webhook-deliveries", deliveryId, "redeliver"));
  }

  /** Send many again: by `ids`, or every delivery matching a filter (up to `limit`, 100 by default). `dryRun` only counts. */
  redeliverMany(options: { ids?: string[]; status?: string; endpoint?: string; event?: string; sinceMinutes?: number; limit?: number; dryRun?: boolean } = {}): Promise<Api> {
    return this.post("/webhook-deliveries/redeliver", {
      ids: options.ids,
      status: options.status ?? "failed",
      endpoint: options.endpoint,
      event: options.event,
      since_minutes: options.sinceMinutes,
      limit: options.limit ?? 100,
      dry_run: options.dryRun ?? false,
    });
  }
}

/** Inbound hooks: URLs other services call (signature-checked), each starting a flow or function. */
export class InboundHooks extends Definitions {
  protected override readonly kind = "inbound-hooks";

  /** The public URL to give the sender. */
  url(slug: string): Promise<Api> {
    return this.get(seg(this.kind, slug, "url"));
  }
}

/** Background work: jobs, failures and replays, queues, workers and how failed work is retried. */
export class Jobs extends Service {
  /** `status`: `queued`, `active`, `retrying`, `succeeded`, `failed`. */
  list(options: { status?: string; queue?: string; limit?: number } = {}): Promise<Api> {
    return this.get("/jobs", options);
  }

  detail(jobId: string): Promise<Api> {
    return this.get(seg("jobs", jobId));
  }

  retry(jobId: string): Promise<Api> {
    return this.post(seg("jobs", jobId, "retry"));
  }

  /** Queue recorded jobs again: named `ids`, or every job matching the filter (failed by default; `limit` 200). `dryRun` only counts. */
  replay(options: { ids?: string[]; status?: string; queue?: string; job?: string; sinceMinutes?: number; limit?: number; dryRun?: boolean } = {}): Promise<Api> {
    return this.post("/jobs/replay", {
      ids: options.ids ?? [],
      status: options.status ?? "failed",
      queue: options.queue,
      job: options.job,
      since_minutes: options.sinceMinutes,
      limit: options.limit ?? 200,
      dry_run: options.dryRun ?? false,
    });
  }

  /** Jobs that gave up after their retries. */
  failed(): Promise<Api> {
    return this.get("/failed-jobs");
  }

  dismissFailed(jobId: string): Promise<Api> {
    return this.del(seg("failed-jobs", jobId));
  }

  /** Queues with depth and job counts. */
  queues(): Promise<Api> {
    return this.get("/queues");
  }

  /** The processes taking jobs (installation-wide). */
  workers(): Promise<Api> {
    return this.project("GET", "/workers");
  }

  /** How each kind of background work is retried: attempts and the wait before each retry. */
  retryPolicies(): Promise<Api> {
    return this.project("GET", "/retry-policies");
  }
}
