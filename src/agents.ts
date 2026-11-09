/**
 * Agents and knowledge bases, run from your app: the signed-in user's access rules decide which agents they may run and which
 * knowledge bases they may search.
 *
 * ```ts
 * const run = await pawabase.ai.agents.run("support", "How do I reset my password?");
 * console.log(run.output);
 * for await (const event of pawabase.ai.agents.stream("support", "Summarise my open tickets")) console.log(event);
 * const hits = await pawabase.ai.knowledge.search("docs", "reset password");
 * ```
 */
import { ApiError } from "./errors.js";
import type { HttpClient } from "./http.js";

export type AgentRunStatus = "running" | "waiting" | "done" | "failed" | (string & {});

/** One run of an agent. A run that stopped to ask permission has `status: "waiting"` and lists what it is waiting on in `pending`. */
export interface AgentRun {
  id: string;
  agent: string;
  status: AgentRunStatus;
  /** The agent's answer, once it has one. */
  output?: string;
  thread_id?: string;
  error?: string;
  /** What it is waiting on when `status` is `waiting`. */
  pending?: Array<{ id: string; name: string; arguments?: unknown; why?: string }>;
  [field: string]: unknown;
}

/** One step of a streamed run (`type` says which: text pieces, tool calls and results, approvals, `error`). */
export interface AgentEvent {
  type: string;
  [field: string]: unknown;
}

export interface AgentRunOptions {
  /** Carry on a conversation: the `thread` of an earlier run. */
  thread?: string;
  /** Return at once; poll `get()` or start a flow from `agent.run.finished`. */
  background?: boolean;
  signal?: AbortSignal | null;
}

export interface KnowledgeHit {
  [field: string]: unknown;
}

export interface KnowledgeDocument {
  id: string;
  status: "pending" | "ready" | "failed" | (string & {});
  title?: string;
  error?: string;
  chunks?: number;
}

const seg = (...parts: string[]) => "/" + parts.map(encodeURIComponent).join("/");

export class AgentsClient {
  constructor(private readonly http: HttpClient) {}

  /** The agents the caller may run. */
  async list(): Promise<Array<{ name: string; description: string }>> {
    const body = await this.http.request<{ data: Array<{ name: string; description: string }> }>({ path: "/ai/v1/agents" });
    return body.data;
  }

  /** Send `input` and wait for the run (or, with `background`, only for it to start). */
  run(name: string, input: string, options: AgentRunOptions = {}): Promise<AgentRun> {
    return this.http.request<AgentRun>({
      method: "POST",
      path: `/ai/v1${seg("agents", name, "runs")}`,
      body: { input, thread: options.thread, background: options.background ?? false },
      signal: options.signal ?? undefined,
    });
  }

  /** Each step of a run as it happens. */
  async *stream(name: string, input: string, options: Omit<AgentRunOptions, "background"> = {}): AsyncGenerator<AgentEvent, void, void> {
    const stream = await this.http.request<ReadableStream<Uint8Array> | null>({
      method: "POST",
      path: `/ai/v1${seg("agents", name, "runs")}`,
      body: { input, thread: options.thread, stream: true },
      parse: "stream",
      signal: options.signal ?? undefined,
    });
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            let parsed: AgentEvent;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            if (parsed.type === "error") {
              throw new ApiError({ status: 502, code: "agent_error", message: String(parsed.message ?? "the run stopped") });
            }
            yield parsed;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** A run of yours: its status and answer, and what it is waiting on if it stopped to ask. */
  get(runId: string): Promise<AgentRun> {
    return this.http.request<AgentRun>({ path: `/ai/v1${seg("agent-runs", runId)}` });
  }

  /** Approve or decline what a run is waiting on: a decision per call id, and `approve` for any not named. */
  decide(runId: string, options: { decisions?: Record<string, boolean>; approve?: boolean; background?: boolean } = {}): Promise<AgentRun> {
    return this.http.request<AgentRun>({
      method: "POST",
      path: `/ai/v1${seg("agent-runs", runId, "decide")}`,
      body: { decisions: options.decisions ?? {}, approve: options.approve, background: options.background ?? false },
    });
  }

  /** Poll a background run until it is no longer running (a waiting run is returned too, so you can decide it). */
  async wait(runId: string, options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal | null } = {}): Promise<AgentRun> {
    const interval = options.intervalMs ?? 1000;
    const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
    for (;;) {
      const run = await this.get(runId);
      if (run.status !== "running") return run;
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
      if (Date.now() >= deadline) throw new Error(`run ${runId} was still running after ${options.timeoutMs ?? 5 * 60_000} ms`);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

export class KnowledgeClient {
  constructor(private readonly http: HttpClient) {}

  /** Search by meaning and by words together. Documents kept private to someone else are left out. */
  async search(name: string, query: string, options: { limit?: number; signal?: AbortSignal | null } = {}): Promise<KnowledgeHit[]> {
    const body = await this.http.request<{ data: KnowledgeHit[] }>({
      method: "POST",
      path: `/ai/v1${seg("knowledge", name, "search")}`,
      body: { query, limit: options.limit ?? 5 },
      signal: options.signal ?? undefined,
    });
    return body.data;
  }

  /** Add text, or a web page to read (`url`). A signed-in user's documents are found only by them. Adding the same `source` again replaces it. */
  addDocument(name: string, input: { text?: string; url?: string; title?: string; source?: string }): Promise<KnowledgeDocument> {
    return this.http.request<KnowledgeDocument>({
      method: "POST",
      path: `/ai/v1${seg("knowledge", name, "documents")}`,
      body: { title: input.title ?? "", source: input.source ?? "", text: input.text, url: input.url },
    });
  }

  /** Add a file (PDF, Word, HTML or text). */
  addFile(name: string, file: Blob, options: { title?: string; source?: string; filename?: string } = {}): Promise<KnowledgeDocument> {
    const form = new FormData();
    form.append("file", file, options.filename ?? (file as File).name ?? "document");
    if (options.title) form.append("title", options.title);
    if (options.source) form.append("source", options.source);
    return this.http.request<KnowledgeDocument>({ method: "POST", path: `/ai/v1${seg("knowledge", name, "documents")}`, body: form });
  }

  /** Whether a document is ready to search, and why not if it failed. */
  document(name: string, documentId: string): Promise<KnowledgeDocument> {
    return this.http.request<KnowledgeDocument>({ path: `/ai/v1${seg("knowledge", name, "documents", documentId)}` });
  }
}
