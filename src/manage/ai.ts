import { Service, seg, type Api, type Body } from "./base.js";

/**
 * The AI gateway of the environment: connect providers (OpenAI, Anthropic, Gemini, Mistral, Groq, or any OpenAI-compatible server), expose
 * models by name, try them, and read what they cost. Provider keys are sealed on arrival and never returned.
 */
export class Ai extends Service {
  protected override path(suffix = ""): string {
    return super.path(`/ai${suffix}`);
  }

  /** The kinds of provider that can be connected, with suggested models. */
  catalog(): Promise<Api> {
    return this.get("/catalog");
  }

  providers(): Promise<Api> {
    return this.get("/providers");
  }

  /** The models a connected provider offers this key, asked live: `{ data: [{ id, kind, label }], source: "provider" | "catalog", error }`. */
  providerModels(name: string): Promise<Api> {
    return this.get(seg("providers", name, "models"));
  }

  /** Connect a provider. `kind` is `openai`, `anthropic`, `gemini`, `mistral`, `groq` or `openai_compatible` (which needs `baseUrl`). */
  connect(input: { name: string; kind: string; key?: string; baseUrl?: string }): Promise<Api> {
    return this.post("/providers", { name: input.name, kind: input.kind, key: input.key ?? "", base_url: input.baseUrl ?? "" });
  }

  updateProvider(name: string, input: { key?: string; baseUrl?: string; enabled?: boolean }): Promise<Api> {
    return this.patch(seg("providers", name), { key: input.key, base_url: input.baseUrl, enabled: input.enabled });
  }

  /** Disconnect a provider and every model on it. */
  disconnect(name: string): Promise<Api> {
    return this.del(seg("providers", name));
  }

  models(): Promise<Api> {
    return this.get("/models");
  }

  /**
   * Expose a model under `alias`. `policy` is who may call it: `service` (servers only, the default), `authenticated`, `public`, or a
   * named policy. `params` are defaults such as `system` and `temperature`; prices are USD per million tokens.
   */
  addModel(input: {
    alias: string;
    provider: string;
    upstream: string;
    kind?: "chat" | "embedding";
    description?: string;
    policy?: unknown;
    params?: Body;
    dimensions?: number;
    inputPrice?: number;
    outputPrice?: number;
    fallback?: string;
    enabled?: boolean;
  }): Promise<Api> {
    return this.post("/models", {
      alias: input.alias,
      provider: input.provider,
      upstream: input.upstream,
      kind: input.kind ?? "chat",
      description: input.description ?? "",
      policy: input.policy ?? "service",
      params: input.params ?? {},
      dimensions: input.dimensions,
      input_price: input.inputPrice,
      output_price: input.outputPrice,
      fallback: input.fallback,
      enabled: input.enabled ?? true,
    });
  }

  updateModel(
    alias: string,
    input: { provider?: string; upstream?: string; description?: string; policy?: unknown; params?: Body; dimensions?: number | null; inputPrice?: number | null; outputPrice?: number | null; fallback?: string | null; enabled?: boolean },
  ): Promise<Api> {
    return this.patch(seg("models", alias), {
      provider: input.provider,
      upstream: input.upstream,
      description: input.description,
      policy: input.policy,
      params: input.params,
      dimensions: input.dimensions,
      input_price: input.inputPrice,
      output_price: input.outputPrice,
      fallback: input.fallback,
      enabled: input.enabled,
    });
  }

  removeModel(alias: string): Promise<Api> {
    return this.del(seg("models", alias));
  }

  /** Send one request to a model, the way Studio's playground does. Returns `{ text, usage, ms }`, or `{ error }`. */
  tryModel(alias: string, input: { messages?: Body[]; input?: string[]; maxTokens?: number } = {}): Promise<Api> {
    return this.post(seg("models", alias, "try"), { messages: input.messages, input: input.input, max_tokens: input.maxTokens });
  }

  /** Calls, tokens, cost and latency over `days` (1 to 90), in all and per model. */
  usage(options: { days?: number } = {}): Promise<Api> {
    return this.get("/usage", { days: options.days ?? 7 });
  }

  /** Recent calls. Never includes what was asked or answered. */
  requests(options: { alias?: string; failed?: boolean; limit?: number } = {}): Promise<Api> {
    return this.get("/requests", { alias: options.alias, failed: options.failed ? "true" : undefined, limit: options.limit ?? 50 });
  }

  /** Vector fields in the environment, and how many records have no vector yet. */
  vectors(): Promise<Api> {
    return this.get("/vectors");
  }

  /** Embed up to `limit` records of a resource that have no vector. Call again while `embedded` is above zero. */
  backfill(resource: string, options: { limit?: number } = {}): Promise<Api> {
    return this.post(seg("backfill", resource), undefined, { limit: options.limit ?? 100 });
  }

  /** Search a resource by meaning, as the Studio does: with `text` or a `vector`. */
  search(resource: string, input: { text?: string; vector?: number[]; field?: string; metric?: "cosine" | "l2" | "ip"; limit?: number }): Promise<Api> {
    return this.post(seg("search", resource), { text: input.text, vector: input.vector, field: input.field, metric: input.metric ?? "cosine", limit: input.limit ?? 10 });
  }
}
