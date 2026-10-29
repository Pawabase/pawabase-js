import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigError, createClient } from "../src/index.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

const body =
  'data: {"type": "welcome", "connection_id": "c9", "channels": ["chat:lobby"]}\n\n' +
  ": keep-alive\n\n" +
  'data: {"type": "message", "channel": "chat:lobby", "event": "hi", "payload": {"n": 1}}\n\n';

test("stream yields the frames of a Server-Sent Events body", async () => {
  const fake = await serve(() => ({ text: body, headers: { "content-type": "text/event-stream" } }));
  const client = createClient({ url: fake.url, apiKey: "pb_pk_test", retry: false });
  const frames: Array<Record<string, any>> = [];
  for await (const frame of client.realtime.stream(["chat:lobby", "chat:ops"])) frames.push(frame);
  assert.deepEqual(frames.map((f) => f.type), ["welcome", "message"]);
  assert.deepEqual(frames[1]!.payload, { n: 1 });
  assert.equal(fake.requests[0]!.path, "/realtime/v1/sse");
  assert.equal(fake.requests[0]!.query.get("channels"), "chat:lobby,chat:ops");
  assert.equal(fake.requests[0]!.headers["accept"], "text/event-stream");
  assert.equal(fake.requests[0]!.headers["apikey"], "pb_pk_test");
  client.dispose();
});

test("stream can be stopped early, needs a channel and surfaces errors", async () => {
  const fake = await serve((req) => (req.query.get("channels") === "secret" ? { status: 403, body: { detail: "not allowed" } } : { text: body }));
  const client = createClient({ url: fake.url, apiKey: "pb_pk_test", retry: false });
  for await (const frame of client.realtime.stream("chat:lobby")) {
    assert.equal(frame.type, "welcome");
    break;
  }
  await assert.rejects(client.realtime.stream([]).next(), ConfigError);
  await assert.rejects(client.realtime.stream("secret").next(), (error: Error) => /not allowed|403/.test(error.message) || error.name.length > 0);
  client.dispose();
});
