import { Definitions, Service, seg, type Api, type Body, type Query } from "./base.js";

/**
 * Agents: a model with instructions, tools and knowledge, run on the server with approvals, limits and threads.
 *
 * ```ts
 * await m.agents.create({ name: "support", model: "chat", instructions: "Answer from the docs.", knowledge: ["docs"] });
 * const run = await m.agents.run("support", "How do I reset a password?");
 * ```
 */
export class Agents extends Definitions {
  protected override readonly kind = "agents";

  /** Run an agent as the studio would. `thread` carries a conversation on; `background` returns before it finishes. */
  run(name: string, input: string, options: { thread?: string; background?: boolean } = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "runs"), { input, thread: options.thread, background: options.background ?? false });
  }
}

/** Agent runs: what each did, step by step, and the ones waiting for someone to approve a tool call. */
export class AgentRuns extends Service {
  /** Newest first. Filter by `agent`, `status` or `thread`. */
  list(options: { agent?: string; status?: string; thread?: string; limit?: number; offset?: number } = {}): Promise<Api> {
    return this.get("/agent-runs", options as Query);
  }

  getOne(runId: string): Promise<Api> {
    return this.get(seg("agent-runs", runId));
  }

  /** Approve or decline what a run is waiting on: a decision per call id, and `approve` for any not named. */
  decide(runId: string, options: { decisions?: Record<string, boolean>; approve?: boolean; background?: boolean } = {}): Promise<Api> {
    return this.post(seg("agent-runs", runId, "decide"), { decisions: options.decisions ?? {}, approve: options.approve, background: options.background ?? false });
  }

  remove(runId: string): Promise<Api> {
    return this.del(seg("agent-runs", runId));
  }

  /** The tools an agent can be given, by kind. */
  tools(): Promise<Api> {
    return this.get("/agent-tools");
  }
}

/** Knowledge bases: documents split and embedded so agents can search them by meaning and by words. */
export class KnowledgeBases extends Definitions {
  protected override readonly kind = "knowledge-bases";

  documents(name: string, options: { limit?: number; offset?: number } = {}): Promise<Api> {
    return this.get(seg(this.kind, name, "documents"), options);
  }

  /** Add text, or a web page to read (`url`). Adding the same `source` again replaces it. */
  addDocument(name: string, input: { text?: string; url?: string; title?: string; source?: string }): Promise<Api> {
    return this.post(seg(this.kind, name, "documents"), { title: input.title ?? "", source: input.source ?? "", text: input.text, url: input.url });
  }

  /** Add a file (PDF, Word, HTML or text). */
  addFile(name: string, file: Blob, options: { title?: string; source?: string; filename?: string } = {}): Promise<Api> {
    const form = new FormData();
    form.append("file", file, options.filename ?? (file as File).name ?? "document");
    if (options.title) form.append("title", options.title);
    if (options.source) form.append("source", options.source);
    return this.post(seg(this.kind, name, "documents"), form);
  }

  removeDocument(name: string, documentId: string): Promise<Api> {
    return this.del(seg(this.kind, name, "documents", documentId));
  }

  /** Split and embed a document again, for one that failed or after changing the base's chunk size. */
  reindexDocument(name: string, documentId: string): Promise<Api> {
    return this.post(seg(this.kind, name, "documents", documentId, "reindex"));
  }

  /** What an agent would find. */
  search(name: string, query: string, options: { limit?: number } = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "search"), { query, limit: options.limit ?? 5 });
  }

  /** Bring in pages from a Notion connection; pages unchanged since last time are skipped. */
  sync(name: string, connection: string): Promise<Api> {
    return this.post(seg(this.kind, name, "sync"), { connection });
  }
}

/** Connections: stored access to outside services (MCP servers, Notion, web search) that agents use as tools. The secret is sealed on arrival. */
export class Connections extends Definitions {
  protected override readonly kind = "connections";

  /** Call the service with the stored key and say what was found, or why it could not be reached. */
  test(name: string): Promise<Api> {
    return this.post(seg(this.kind, name, "test"));
  }
}

export type { Body };
