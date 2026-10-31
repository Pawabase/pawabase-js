import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ApiError, createClient } from "../src/index.js";
import { manage } from "../src/manage/index.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

const options = { apiKey: "pb_sk_test", environment: "production", retry: false as const };

test("chat sends the model and messages and returns the text; complete returns everything", async () => {
  const fake = await serve(() => ({ body: { id: "c1", object: "chat.completion", model: "chat", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } }));
  const client = createClient({ url: fake.url, ...options });
  assert.equal(await client.ai.chat("chat", "hi", { temperature: 0.2, maxTokens: 20 }), "hello");
  assert.equal(fake.requests[0]!.path, "/ai/v1/chat/completions");
  assert.deepEqual(fake.requests[0]!.json, { model: "chat", messages: [{ role: "user", content: "hi" }], temperature: 0.2, max_tokens: 20 });
  const full = await client.ai.complete("chat", [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }]);
  assert.equal(full.usage?.total_tokens, 4);
  assert.equal((fake.requests[1]!.json as { messages: unknown[] }).messages.length, 2);
  client.dispose();
});

test("stream yields the text pieces and stops at [DONE]", async () => {
  const events = ['{"choices":[{"delta":{"role":"assistant","content":""}}]}', '{"choices":[{"delta":{"content":"Hel"}}]}', '{"choices":[{"delta":{"content":"lo"}}]}', "[DONE]"];
  const fake = await serve(() => ({ text: events.map((e) => `data: ${e}\n\n`).join(""), headers: { "content-type": "text/event-stream" } }));
  const client = createClient({ url: fake.url, ...options });
  const pieces: string[] = [];
  for await (const piece of client.ai.stream("chat", "hi")) pieces.push(piece);
  assert.deepEqual(pieces, ["Hel", "lo"]);
  assert.equal((fake.requests[0]!.json as { stream: boolean }).stream, true);
  client.dispose();
});

test("a stream error event becomes an ApiError", async () => {
  const fake = await serve(() => ({ text: 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"error":{"message":"the provider stopped answering","type":"provider_error"}}\n\n', headers: { "content-type": "text/event-stream" } }));
  const client = createClient({ url: fake.url, ...options });
  const seen: string[] = [];
  await assert.rejects(async () => { for await (const piece of client.ai.stream("chat", "hi")) seen.push(piece); }, (error: unknown) => error instanceof ApiError && /stopped answering/.test(error.message));
  assert.deepEqual(seen, ["a"]);
  client.dispose();
});

test("embed returns one vector for a string and a list of vectors for a list, in order", async () => {
  const fake = await serve((req) => ({ body: { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }].slice(0, (req.json as { input: unknown }).input === "a" ? 1 : 2) } }));
  const client = createClient({ url: fake.url, ...options });
  assert.deepEqual(await client.ai.embed("embed", "a"), [3, 4]);
  assert.deepEqual(await client.ai.embed("embed", ["a", "b"]), [[1, 2], [3, 4]]);
  client.dispose();
});

test("a gateway error in OpenAI's shape keeps its message and code", async () => {
  const fake = await serve(() => ({ status: 403, body: { error: { message: "you may not use this model", type: "invalid_request_error", code: "forbidden" } } }));
  const client = createClient({ url: fake.url, ...options });
  await assert.rejects(client.ai.chat("chat", "hi"), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "forbidden" && error.message === "you may not use this model");
  client.dispose();
});

test("similar posts a text or vector query to the resource", async () => {
  const fake = await serve(() => ({ body: { data: [{ id: "1", title: "Cats", distance: 0.1 }], metric: "cosine", count: 1 } }));
  const client = createClient({ url: fake.url, ...options });
  const found = await client.from("notes").similar({ text: "cats", limit: 3, maxDistance: 0.5 });
  assert.equal(fake.requests[0]!.path, "/rest/v1/notes/similar");
  assert.deepEqual(fake.requests[0]!.json, { text: "cats", metric: "cosine", limit: 3, max_distance: 0.5 });
  assert.equal(found.data[0]!.distance, 0.1);
  client.dispose();
});

test("gateway administration is scoped to the environment", async () => {
  const fake = await serve(() => ({ body: { data: [] } }));
  const client = createClient({ url: fake.url, ...options });
  const ai = manage(client).ai;
  const last = () => fake.requests[fake.requests.length - 1]!;
  await ai.connect({ name: "openai", kind: "openai", key: "sk-1" });
  assert.equal(last().path, "/platform/v1/envs/production/ai/providers");
  assert.deepEqual(last().json, { name: "openai", kind: "openai", key: "sk-1", base_url: "" });
  await ai.addModel({ alias: "chat", provider: "openai", upstream: "gpt-4o-mini", inputPrice: 0.15, params: { system: "Be brief." } });
  assert.equal(last().path, "/platform/v1/envs/production/ai/models");
  assert.equal((last().json as { policy: string }).policy, "service");
  await ai.providerModels("openai");
  assert.equal(last().path, "/platform/v1/envs/production/ai/providers/openai/models");
  await ai.usage({ days: 30 });
  assert.equal(last().path, "/platform/v1/envs/production/ai/usage");
  assert.equal(last().query.get("days"), "30");
  await ai.backfill("notes");
  assert.equal(last().path, "/platform/v1/envs/production/ai/backfill/notes");
  await ai.search("notes", { text: "cats" });
  assert.deepEqual(last().json, { text: "cats", metric: "cosine", limit: 10 });
  await ai.removeModel("chat");
  assert.equal(last().method, "DELETE");
  client.dispose();
});
