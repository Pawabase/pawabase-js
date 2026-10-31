/**
 * The AI gateway: chat and embedding models your environment has connected, behind one OpenAI-compatible API.
 *
 * ```ts
 * const answer = await pawabase.ai.chat("chat", "Summarise this ticket: …");
 * for await (const piece of pawabase.ai.stream("chat", "Tell me a story")) process.stdout.write(piece);
 * const vector = await pawabase.ai.embed("embed", "hello");
 * ```
 *
 * Models are called by the name your environment gave them. Who may call each is the model's policy; servers (a secret key) always may.
 */
import { ApiError } from "./errors.js";
import type { HttpClient } from "./http.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  /** Functions the model may ask you to call (OpenAI's `tools` format). */
  tools?: unknown[];
  toolChoice?: unknown;
  /** `{ type: "json_object" }` asks for JSON back, where the provider supports it. */
  responseFormat?: { type: string; [key: string]: unknown };
  /** Any other parameter, passed through as given. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal | null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  model: string;
  choices: Array<{ index: number; message: ChatMessage; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface AiModelInfo {
  id: string;
  kind: "chat" | "embedding";
  description: string;
  dimensions?: number;
}

function asMessages(input: string | ChatMessage[]): ChatMessage[] {
  return typeof input === "string" ? [{ role: "user", content: input }] : input;
}

function bodyOf(model: string, input: string | ChatMessage[], options: ChatOptions): Record<string, unknown> {
  return {
    ...(options.extra ?? {}),
    model,
    messages: asMessages(input),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
    ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
  };
}

export class AiClient {
  constructor(private readonly http: HttpClient) {}

  /** The models the caller may use. */
  async models(): Promise<AiModelInfo[]> {
    const body = await this.http.request<{ data: AiModelInfo[] }>({ path: "/ai/v1/models" });
    return body.data;
  }

  /** The full chat completion, in OpenAI's shape (tool calls, usage and all). */
  complete(model: string, input: string | ChatMessage[], options: ChatOptions = {}): Promise<ChatCompletion> {
    return this.http.request<ChatCompletion>({
      method: "POST",
      path: "/ai/v1/chat/completions",
      body: bodyOf(model, input, options),
      signal: options.signal ?? undefined,
    });
  }

  /** Ask a model and get its answer as text. */
  async chat(model: string, input: string | ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const completion = await this.complete(model, input, options);
    return completion.choices[0]?.message?.content ?? "";
  }

  /** The answer as it is written: an async iterator of text pieces. */
  async *stream(model: string, input: string | ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string, void, void> {
    const stream = await this.http.request<ReadableStream<Uint8Array> | null>({
      method: "POST",
      path: "/ai/v1/chat/completions",
      body: { ...bodyOf(model, input, options), stream: true },
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
            let parsed: { choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string; code?: string } };
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            if (parsed.error) {
              throw new ApiError({ status: 502, code: parsed.error.code ?? "provider_error", message: parsed.error.message ?? "the model stopped answering" });
            }
            const piece = parsed.choices?.[0]?.delta?.content;
            if (piece) yield piece;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** The vector for one text, or one vector per text when given a list. */
  embed(model: string, input: string, options?: { signal?: AbortSignal | null }): Promise<number[]>;
  embed(model: string, input: string[], options?: { signal?: AbortSignal | null }): Promise<number[][]>;
  async embed(model: string, input: string | string[], options: { signal?: AbortSignal | null } = {}): Promise<number[] | number[][]> {
    const body = await this.http.request<{ data: Array<{ index: number; embedding: number[] }> }>({
      method: "POST",
      path: "/ai/v1/embeddings",
      body: { model, input },
      signal: options.signal ?? undefined,
    });
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((row) => row.embedding);
    return typeof input === "string" ? (vectors[0] ?? []) : vectors;
  }
}
