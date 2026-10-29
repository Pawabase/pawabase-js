import { type Api, Service, seg } from "./base.js";

export type ChannelKind = "public" | "private" | "presence" | "protected" | "ephemeral" | "durable";

export interface ChannelRule {
  kind?: ChannelKind;
  /** The policy that decides who may subscribe. Default `authenticated`. */
  subscribe?: string;
  /** The policy that decides who may publish. Default `authenticated`. */
  publish?: string;
  presence?: boolean;
  /** How many recent messages are kept (0 to 1000). */
  history?: number;
  /** A limit of `0` means none. */
  messageSizeLimit?: number;
  publishRateLimit?: number;
  subscriptionLimit?: number;
  retentionSeconds?: number;
  description?: string;
}

const wire = (rule: ChannelRule): Record<string, unknown> => {
  const map: Record<string, unknown> = {
    kind: rule.kind,
    subscribe: rule.subscribe,
    publish: rule.publish,
    presence: rule.presence,
    history: rule.history,
    message_size_limit: rule.messageSizeLimit,
    publish_rate_limit: rule.publishRateLimit,
    subscription_limit: rule.subscriptionLimit,
    retention_seconds: rule.retentionSeconds,
    description: rule.description,
  };
  return Object.fromEntries(Object.entries(map).filter(([, value]) => value !== undefined));
};

/** Durable channel rules: a channel name pattern (`chat:*`), its kind, who may subscribe and publish, presence, history and limits. */
export class RealtimeChannels extends Service {
  list(): Promise<Api> {
    return this.get("/realtime-channels");
  }

  /** Add a rule for channels matching `pattern`. */
  create(pattern: string, rule: ChannelRule = {}): Promise<Api> {
    return this.post("/realtime-channels", { pattern, ...wire(rule) });
  }

  update(channelId: string, changes: ChannelRule): Promise<Api> {
    return this.patch(seg("realtime-channels", channelId), wire(changes));
  }

  remove(channelId: string): Promise<Api> {
    return this.del(seg("realtime-channels", channelId));
  }
}

/** Dashboards: read-only boards over your data, defined as JSON, optionally published at a public address. */
export class Dashboards extends Service {
  list(): Promise<Api> {
    return this.get("/dashboards");
  }

  /** One dashboard with its full definition. */
  getOne(dashboardId: string): Promise<Api> {
    return this.get(seg("dashboards", dashboardId));
  }

  /** Make a dashboard (`name`: lowercase letters, digits and dashes). The definition is checked; a problem comes back as a 422 with the list. */
  create(name: string, options: { definition?: Record<string, unknown>; title?: string; description?: string; enabled?: boolean } = {}): Promise<Api> {
    return this.post("/dashboards", {
      name,
      title: options.title ?? "",
      description: options.description ?? "",
      definition: options.definition ?? { pages: [] },
      enabled: options.enabled ?? true,
    });
  }

  update(dashboardId: string, changes: { title?: string; description?: string; definition?: Record<string, unknown>; enabled?: boolean }): Promise<Api> {
    return this.patch(seg("dashboards", dashboardId), Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)));
  }

  remove(dashboardId: string): Promise<Api> {
    return this.del(seg("dashboards", dashboardId));
  }

  /** Turn the public page on or off. Turning it on needs the environment's publishable key once (it is sealed and never returned). */
  publish(dashboardId: string, options: { public: boolean; publishableKey?: string }): Promise<Api> {
    return this.put(seg("dashboards", dashboardId, "publish"), {
      public: options.public,
      ...(options.publishableKey ? { publishable_key: options.publishableKey } : {}),
    });
  }
}
