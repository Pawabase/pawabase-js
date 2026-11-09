import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ApiError, createClient } from "../src/index.js";
import { manage } from "../src/manage/index.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

const options = { apiKey: "pb_sk_test", environment: "production", retry: false as const };
const BASE = "/platform/v1/envs/production";

test("agents list, run and read a run", async () => {
  const fake = await serve((r) => ({ status: r.method === "POST" ? 201 : 200, body: r.path.endsWith("/agents") ? { data: [{ name: "support", description: "" }] } : { id: "r1", agent: "support", status: "done", output: "done" } }));
  const client = createClient({ url: fake.url, ...options });
  assert.equal((await client.ai.agents.list())[0]!.name, "support");
  const run = await client.ai.agents.run("support", "hi", { thread: "t1" });
  assert.equal(run.output, "done");
  assert.equal(fake.requests[1]!.path, "/ai/v1/agents/support/runs");
  assert.deepEqual(fake.requests[1]!.json, { input: "hi", thread: "t1", background: false });
  await client.ai.agents.decide("r1", { decisions: { c1: true } });
  assert.equal(fake.requests[2]!.path, "/ai/v1/agent-runs/r1/decide");
  assert.equal((fake.requests[2]!.json as { decisions: Record<string, boolean> }).decisions.c1, true);
  client.dispose();
});

test("an agent stream yields events and stops at [DONE]; an error event throws", async () => {
  const ok = await serve(() => ({ text: 'data: {"type":"text","text":"Hi"}\n\ndata: {"type":"done"}\n\ndata: [DONE]\n\n', headers: { "content-type": "text/event-stream" } }));
  const client = createClient({ url: ok.url, ...options });
  const types: string[] = [];
  for await (const event of client.ai.agents.stream("support", "hi")) types.push(event.type);
  assert.deepEqual(types, ["text", "done"]);
  assert.equal((ok.requests[0]!.json as { stream: boolean }).stream, true);
  client.dispose();

  const bad = await serve(() => ({ text: 'data: {"type":"error","message":"nope"}\n\n', headers: { "content-type": "text/event-stream" } }));
  const failing = createClient({ url: bad.url, ...options });
  await assert.rejects(async () => {
    for await (const _ of failing.ai.agents.stream("support", "hi")) void _;
  }, ApiError);
  failing.dispose();
});

test("wait polls until the run is no longer running", async () => {
  let n = 0;
  const fake = await serve(() => ({ body: { id: "r1", agent: "a", status: ++n < 3 ? "running" : "done" } }));
  const client = createClient({ url: fake.url, ...options });
  const run = await client.ai.agents.wait("r1", { intervalMs: 1 });
  assert.equal(run.status, "done");
  assert.equal(fake.requests.length, 3);
  client.dispose();
});

test("knowledge search, add and status", async () => {
  const fake = await serve(() => ({ body: { data: [{ text: "x" }], id: "d1", status: "pending" } }));
  const client = createClient({ url: fake.url, ...options });
  assert.equal((await client.ai.knowledge.search("docs", "reset", { limit: 3 })).length, 1);
  assert.equal(fake.requests[0]!.path, "/ai/v1/knowledge/docs/search");
  assert.deepEqual(fake.requests[0]!.json, { query: "reset", limit: 3 });
  await client.ai.knowledge.addDocument("docs", { text: "hello", title: "T", source: "s" });
  assert.deepEqual(fake.requests[1]!.json, { title: "T", source: "s", text: "hello" });
  await client.ai.knowledge.addFile("docs", new Blob(["x"]), { filename: "a.txt" });
  assert.match(String(fake.requests[2]!.headers["content-type"]), /multipart\/form-data/);
  await client.ai.knowledge.document("docs", "d1");
  assert.equal(fake.requests[3]!.path, "/ai/v1/knowledge/docs/documents/d1");
  client.dispose();
});

test("management: agents, runs, knowledge bases, connections and the rest", async () => {
  const fake = await serve(() => ({ body: { data: [] } }));
  const client = createClient({ url: fake.url, ...options });
  const m = manage(client);
  const last = () => fake.requests[fake.requests.length - 1]!;
  await m.agents.run("support", "hi", { background: true });
  assert.equal(last().path, `${BASE}/agents/support/runs`);
  assert.deepEqual(last().json, { input: "hi", background: true });
  await m.agentRuns.list({ agent: "support", status: "waiting" });
  assert.equal(last().path, `${BASE}/agent-runs`);
  assert.equal(last().query.get("status"), "waiting");
  await m.agentRuns.decide("r1", { approve: true });
  assert.equal(last().path, `${BASE}/agent-runs/r1/decide`);
  await m.agentRuns.tools();
  assert.equal(last().path, `${BASE}/agent-tools`);
  await m.knowledgeBases.addDocument("docs", { url: "https://example.com" });
  assert.equal(last().path, `${BASE}/knowledge-bases/docs/documents`);
  await m.knowledgeBases.reindexDocument("docs", "d1");
  assert.equal(last().path, `${BASE}/knowledge-bases/docs/documents/d1/reindex`);
  await m.knowledgeBases.search("docs", "q");
  assert.deepEqual(last().json, { query: "q", limit: 5 });
  await m.knowledgeBases.sync("docs", "notion");
  assert.deepEqual(last().json, { connection: "notion" });
  await m.connections.test("notion");
  assert.equal(last().path, `${BASE}/connections/notion/test`);
  await m.buckets.createFolder("files", "a/b");
  assert.deepEqual(last().json, { prefix: "a/b" });
  await m.buckets.deleteFolder("files", "a/b");
  assert.equal(last().path, `${BASE}/buckets/files/folders/a/b`);
  await m.database.saveQuery({ name: "q", sql: "select 1" });
  assert.equal(last().path, `${BASE}/database/queries`);
  await m.mailTemplates.rename("a", "b");
  assert.deepEqual(last().json, { to: "b" });
  await m.mail.saveKit({ folders: ["x"] });
  assert.equal(last().path, `${BASE}/mail/kit`);
  await m.observability.bandwidth({ minutes: 60 });
  assert.equal(last().path, `${BASE}/observability/bandwidth`);
  await m.cache.stats();
  assert.equal(last().path, "/platform/v1/cache");
  client.dispose();
});
