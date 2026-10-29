/**
 * The management plane of one environment, with that environment's secret key (`pb_sk_…`).
 *
 * ```ts
 * import { createClient } from "@pawabase/client";
 * import { manage } from "@pawabase/client/manage";
 *
 * const pawabase = createClient({ url, apiKey: "pb_sk_…", environment: "production" });
 * const m = manage(pawabase);
 * await m.secrets.set("STRIPE_KEY", "sk_live_…");
 * await manage(pawabase, "staging").flows.list();     // the same API for another environment the key may manage
 * ```
 */
import type { PawabaseClient } from "../client.js";
import { ConfigError } from "../errors.js";
import { isSecretKey } from "../util.js";
import { Domains, Firewall, Keys, Secrets } from "./access.js";
import { Events, Flows, InboundHooks, Jobs, Schedules, Subscriptions, Webhooks } from "./automation.js";
import { Database, Policies, Resources, Routes, Runtime, Schema, Schemas, Transformers } from "./data.js";
import { Buckets, Cache } from "./files.js";
import { Functions } from "./functions.js";
import { Backups, Environments, Releases } from "./lifecycle.js";
import { Mail, MailTemplates } from "./mail.js";
import { Alarms, Health, Observability, StatusPage } from "./observe.js";
import { Dashboards, RealtimeChannels } from "./realtime.js";

export class Manage {
  // data
  readonly resources: Resources;
  readonly schema: Schema;
  readonly policies: Policies;
  readonly schemas: Schemas;
  readonly transformers: Transformers;
  readonly routes: Routes;
  readonly database: Database;
  readonly runtime: Runtime;
  // automation
  readonly flows: Flows;
  readonly schedules: Schedules;
  readonly subscriptions: Subscriptions;
  readonly events: Events;
  readonly webhooks: Webhooks;
  readonly inboundHooks: InboundHooks;
  readonly jobs: Jobs;
  readonly functions: Functions;
  // files and mail
  readonly buckets: Buckets;
  readonly cache: Cache;
  readonly mail: Mail;
  readonly mailTemplates: MailTemplates;
  // realtime and dashboards
  readonly realtimeChannels: RealtimeChannels;
  readonly dashboards: Dashboards;
  // access
  readonly keys: Keys;
  readonly secrets: Secrets;
  readonly domains: Domains;
  readonly firewall: Firewall;
  // observe
  readonly observability: Observability;
  readonly alarms: Alarms;
  readonly statusPage: StatusPage;
  readonly health: Health;
  // lifecycle
  readonly environments: Environments;
  readonly releases: Releases;
  readonly backups: Backups;

  constructor(
    private readonly client: PawabaseClient<any>,
    readonly environment: string,
  ) {
    const http = client.http;
    this.resources = new Resources(http, environment);
    this.schema = new Schema(http, environment);
    this.policies = new Policies(http, environment);
    this.schemas = new Schemas(http, environment);
    this.transformers = new Transformers(http, environment);
    this.routes = new Routes(http, environment);
    this.database = new Database(http, environment);
    this.runtime = new Runtime(http, environment);
    this.flows = new Flows(http, environment);
    this.schedules = new Schedules(http, environment);
    this.subscriptions = new Subscriptions(http, environment);
    this.events = new Events(http, environment);
    this.webhooks = new Webhooks(http, environment);
    this.inboundHooks = new InboundHooks(http, environment);
    this.jobs = new Jobs(http, environment);
    this.functions = new Functions(http, environment);
    this.buckets = new Buckets(http, environment);
    this.cache = new Cache(http, environment);
    this.mail = new Mail(http, environment);
    this.mailTemplates = new MailTemplates(http, environment);
    this.realtimeChannels = new RealtimeChannels(http, environment);
    this.dashboards = new Dashboards(http, environment);
    this.keys = new Keys(http, environment);
    this.secrets = new Secrets(http, environment);
    this.domains = new Domains(http, environment);
    this.firewall = new Firewall(http, environment);
    this.observability = new Observability(http, environment);
    this.alarms = new Alarms(http, environment);
    this.statusPage = new StatusPage(http, environment);
    this.health = new Health(http, environment);
    this.environments = new Environments(http, environment);
    this.releases = new Releases(http, environment);
    this.backups = new Backups(http, environment);
  }

  /** The same services for another environment the key may manage. */
  withEnvironment(name: string): Manage {
    return new Manage(this.client, name);
  }
}

/** The management plane of the client's environment (or `environment`). Needs a secret key. */
export function manage(client: PawabaseClient<any>, environment?: string): Manage {
  if (!isSecretKey(client.options.apiKey)) {
    throw new ConfigError("The management plane needs a secret key (pb_sk_…).");
  }
  return new Manage(client, environment ?? client.options.environment ?? "development");
}

export * from "./access.js";
export * from "./automation.js";
export * from "./base.js";
export * from "./data.js";
export * from "./files.js";
export * from "./functions.js";
export * from "./lifecycle.js";
export * from "./mail.js";
export * from "./observe.js";
export * from "./realtime.js";
