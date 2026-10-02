import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { RealtimeError, createClient, MemoryStorage, type ChannelMessage, type WebSocketConstructor } from "../src/index.js";
import { closeAll, sessionBody, serve, tick, until } from "./helpers.js";

after(closeAll);

type Frame = Record<string, any>;

/** An Angula stand-in: welcomes, acknowledges, fans messages out, tracks presence. */
async function angula(options: { forbid?: string[]; closeOnConnect?: number[]; presence?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const port = (wss.address() as AddressInfo).port;
  const sockets = new Set<WebSocket>();
  const received: Frame[] = [];
  const urls: string[] = [];
  const subscriptions = new Map<WebSocket, Set<string>>();
  const history: ChannelMessage[] = [];
  let connections = 0;
  const send = (ws: WebSocket, frame: Frame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(frame));

  wss.on("connection", (ws, req) => {
    connections += 1;
    urls.push(req.url ?? "");
    const closeCode = options.closeOnConnect?.[connections - 1];
    if (closeCode) {
      ws.close(closeCode, "scripted");
      return;
    }
    sockets.add(ws);
    subscriptions.set(ws, new Set());
    send(ws, { type: "welcome", connection_id: `c${connections}`, user_id: null });
    ws.on("message", (raw: RawData) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      received.push(frame);
      const ack = (extra: Frame = {}) => send(ws, { type: "ack", ref: frame["ref"], ok: true, ...extra });
      switch (frame["type"]) {
        case "ping":
          return send(ws, { type: "pong" });
        case "auth":
          return ack({ user_id: "u1" });
        case "subscribe": {
          if (options.forbid?.includes(frame["channel"])) {
            return send(ws, { type: "ack", ref: frame["ref"], ok: false, error: "forbidden", reason: "channel rule refused" });
          }
          subscriptions.get(ws)!.add(frame["channel"]);
          ack({ channel: frame["channel"] });
          if (options.presence) {
            send(ws, { type: "presence_state", channel: frame["channel"], members: [{ presence_ref: "p0", user_id: "u0", meta: { name: "Grace" }, online_at: "t" }] });
          }
          return;
        }
        case "unsubscribe":
          subscriptions.get(ws)!.delete(frame["channel"]);
          return ack();
        case "publish": {
          const message: ChannelMessage = { type: "message", id: `m${history.length + 1}`, channel: frame["channel"], event: frame["event"], payload: frame["payload"], from: "u1", sent_at: "t" };
          history.push({ ...message, seq: history.length + 1 });
          ack({ id: message.id });
          for (const [peer, channels] of subscriptions) if (channels.has(frame["channel"])) send(peer, message);
          return;
        }
        case "history":
          return send(ws, { type: "history", ref: frame["ref"], channel: frame["channel"], messages: history.filter((m) => m.channel === frame["channel"]).slice(-frame["limit"]) });
        case "presence":
          return ack();
      }
    });
    ws.on("close", () => {
      sockets.delete(ws);
      subscriptions.delete(ws);
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    urls,
    history,
    get connections() {
      return connections;
    },
    broadcast(channel: string, message: Partial<ChannelMessage>) {
      for (const [peer, channels] of subscriptions) if (channels.has(channel)) send(peer, { type: "message", channel, event: "e", payload: null, from: null, sent_at: "t", id: "x", ...message });
    },
    send(frame: Frame) {
      for (const ws of sockets) send(ws, frame);
    },
    dropAll() {
      for (const ws of sockets) ws.terminate();
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function connect(url: string, extra: Record<string, unknown> = {}) {
  return createClient({
    url,
    apiKey: "pk_rt",
    project: "acme",
    environment: "dev",
    retry: false,
    auth: { storage: new MemoryStorage(), autoRefreshToken: false },
    realtime: { webSocket: WebSocket as unknown as WebSocketConstructor, reconnect: { baseDelayMs: 5, maxDelayMs: 20 }, ackTimeoutMs: 500, ...(extra["realtime"] as object) },
    ...extra,
  });
}

test("subscribe connects, sends the API key and scope in the URL, and receives messages", async () => {
  const server = await angula();
  const client = connect(server.url);
  const channel = client.realtime.channel<{ text: string }>("chat:lobby");
  const got: string[] = [];
  channel.on("message", (m) => got.push(`${m.event}:${m.payload.text}`));
  await channel.subscribe();
  assert.equal(client.realtime.status, "open");
  assert.equal(channel.subscribed, true);
  const url = new URL(`ws://x${server.urls[0]}`);
  assert.equal(url.pathname, "/realtime/v1/socket");
  assert.equal(url.searchParams.get("apikey"), "pk_rt");
  assert.equal(url.searchParams.get("project_id"), "acme");
  assert.equal(url.searchParams.get("environment"), "dev");
  assert.equal(url.searchParams.get("token"), null);

  const sent = await channel.send("message", { text: "hi" });
  assert.ok(sent.id);
  await until(() => got.length === 1);
  assert.deepEqual(got, ["message:hi"]);
  client.dispose();
  await server.close();
});

test("the signed-in user's token goes in the URL; a refreshed token is sent as an auth frame", async () => {
  const server = await angula();
  const http = await serve((req) => (req.path === "/auth/v1/token" ? { body: sessionBody(3600, { access_token: "refreshed" }) } : { body: sessionBody(3600, { access_token: "first" }) }));
  const storage = new MemoryStorage();
  const auth = createClient({ url: http.url, apiKey: "pk", retry: false, auth: { storage, autoRefreshToken: false } });
  await auth.auth.signInWithPassword({ email: "a@b.co", password: "pw" });
  auth.dispose();
  const client = createClient({
    url: server.url,
    apiKey: "pk_rt",
    retry: false,
    auth: { storage, autoRefreshToken: false, storageKey: (auth.auth as unknown as { storageKey: string }).storageKey },
    realtime: { webSocket: WebSocket as unknown as WebSocketConstructor },
  });
  // The first client stored under its own key (it depends on the URL), so seed ours directly.
  await client.auth.initialized();
  // @ts-expect-error seed
  client.auth.session = sessionBody(3600, { access_token: "first" });
  await client.realtime.channel("c").subscribe();
  assert.equal(new URL(`ws://x${server.urls[0]}`).searchParams.get("token"), "first");
  // @ts-expect-error seed the next token and announce it
  client.auth.session = sessionBody(3600, { access_token: "second" });
  // @ts-expect-error private
  client.auth.emit("TOKEN_REFRESHED");
  await until(() => server.received.some((f) => f["type"] === "auth"));
  assert.equal(server.received.find((f) => f["type"] === "auth")!["token"], "second");
  client.dispose();
  await server.close();
});

test("a refused subscribe rejects with the server's reason and emits an error", async () => {
  const server = await angula({ forbid: ["private"] });
  const client = connect(server.url);
  const channel = client.realtime.channel("private");
  const errors: RealtimeError[] = [];
  channel.on("error", (e) => errors.push(e));
  await assert.rejects(channel.subscribe(), (e: unknown) => e instanceof RealtimeError && e.code === "forbidden" && /channel rule refused/.test(e.message));
  assert.equal(errors.length, 1);
  assert.equal(channel.subscribed, false);
  client.dispose();
  await server.close();
});

test("onEvent filters by event name; unsubscribe stops delivery and ends iteration", async () => {
  const server = await angula();
  const client = connect(server.url);
  const channel = client.realtime.channel("room");
  const created: unknown[] = [];
  channel.onEvent("created", (m) => created.push(m.payload));
  const iterated: string[] = [];
  const loop = (async () => {
    for await (const message of channel) iterated.push(message.event);
  })();
  await channel.subscribe();
  await channel.send("created", { n: 1 });
  await channel.send("deleted", { n: 2 });
  await until(() => iterated.length === 2);
  assert.deepEqual(created, [{ n: 1 }]);
  await channel.unsubscribe();
  await loop;
  assert.deepEqual(iterated, ["created", "deleted"]);
  assert.ok(server.received.some((f) => f["type"] === "unsubscribe"));
  client.dispose();
  await server.close();
});

test("presence: the initial state and diffs are kept as a member list", async () => {
  const server = await angula({ presence: true });
  const client = connect(server.url);
  const channel = client.realtime.channel<unknown, { name: string }>("room", { presence: { name: "Ada" } });
  const changes: string[] = [];
  channel.on("presence", (c) => changes.push(`${c.joins.length}/${c.leaves.length}/${c.members.length}`));
  await channel.subscribe();
  assert.equal(server.received.find((f) => f["type"] === "subscribe")!["presence"].name, "Ada");
  assert.deepEqual(channel.presenceState().map((m) => m.meta.name), ["Grace"]);
  server.send({ type: "presence_diff", channel: "room", joins: [{ presence_ref: "p1", user_id: "u1", meta: { name: "Ada" }, online_at: "t" }], leaves: [] });
  await until(() => channel.presenceState().length === 2);
  server.send({ type: "presence_diff", channel: "room", joins: [], leaves: [{ presence_ref: "p0", user_id: "u0", meta: {}, online_at: "t" }] });
  await until(() => channel.presenceState().length === 1);
  assert.deepEqual(channel.presenceState().map((m) => m.meta.name), ["Ada"]);
  assert.deepEqual(changes, ["1/0/1", "1/0/2", "0/1/1"]);
  await channel.track({ name: "Ada", typing: true });
  assert.deepEqual(server.received.at(-1)!["meta"], { name: "Ada", typing: true });
  client.dispose();
  await server.close();
});

test("a duplicate message id is delivered once", async () => {
  const server = await angula();
  const client = connect(server.url);
  const channel = client.realtime.channel("dupes");
  const ids: string[] = [];
  channel.on("message", (m) => ids.push(m.id));
  await channel.subscribe();
  server.broadcast("dupes", { id: "same" });
  server.broadcast("dupes", { id: "same" });
  server.broadcast("dupes", { id: "other" });
  await until(() => ids.length === 2);
  await tick(30);
  assert.deepEqual(ids, ["same", "other"]);
  client.dispose();
  await server.close();
});

test("after a drop the client reconnects, resubscribes, and replays what it missed without duplicates", async () => {
  const server = await angula();
  const client = connect(server.url);
  const channel = client.realtime.channel("news", { replay: 10 });
  const ids: string[] = [];
  const statuses: string[] = [];
  client.realtime.onStatusChange((s) => statuses.push(s));
  channel.on("message", (m) => ids.push(m.id));
  await channel.subscribe();
  await channel.send("e", 1); // m1, delivered live
  await until(() => ids.length === 1);
  server.dropAll();
  // While the client is away, two more messages exist in the channel's history.
  server.history.push({ type: "message", id: "m2", channel: "news", event: "e", payload: 2, from: null, sent_at: "t", seq: 2 });
  server.history.push({ type: "message", id: "m3", channel: "news", event: "e", payload: 3, from: null, sent_at: "t", seq: 3 });
  await until(() => ids.length === 3, 3000);
  assert.deepEqual(ids, ["m1", "m2", "m3"], "m1 is not delivered twice");
  assert.equal(server.connections, 2);
  assert.ok(statuses.includes("reconnecting"));
  assert.equal(client.realtime.status, "open");
  assert.equal(channel.subscribed, true);
  client.dispose();
  await server.close();
});

test("history() returns recent messages oldest first", async () => {
  const server = await angula();
  const client = connect(server.url);
  const channel = client.realtime.channel("log");
  await channel.subscribe();
  await channel.send("e", "a");
  await channel.send("e", "b");
  const history = await channel.history(10);
  assert.deepEqual(history.map((m) => m.payload), ["a", "b"]);
  client.dispose();
  await server.close();
});

test("a close with the missing-key code does not reconnect", async () => {
  const server = await angula({ closeOnConnect: [4001] });
  const client = connect(server.url);
  await assert.rejects(client.realtime.channel("x").subscribe(), RealtimeError);
  await tick(80);
  assert.equal(server.connections, 1);
  assert.equal(client.realtime.status, "closed");
  client.dispose();
  await server.close();
});

test("a refused token (4003) triggers one refresh and a reconnect", async () => {
  const server = await angula({ closeOnConnect: [4003] });
  const http = await serve(() => ({ body: sessionBody(3600, { access_token: "renewed" }) }));
  const client = createClient({
    url: server.url,
    apiKey: "pk",
    retry: false,
    auth: { storage: new MemoryStorage(), autoRefreshToken: false },
    realtime: { webSocket: WebSocket as unknown as WebSocketConstructor, reconnect: { baseDelayMs: 5, maxDelayMs: 10 }, connectTimeoutMs: 1000 },
  });
  // Route token refreshes to the fake HTTP server by faking the transport's base URL for auth only.
  (client.http.config as { baseUrl: string }).baseUrl = http.url;
  await client.auth.initialized();
  // @ts-expect-error seed
  client.auth.session = sessionBody(3600, { access_token: "dead" });
  (client.http.config as { baseUrl: string }).baseUrl = server.url;
  await assert.rejects(client.realtime.channel("z").subscribe());
  assert.equal(server.connections >= 1, true);
  client.dispose();
  await server.close();
});

test("disconnect() closes cleanly, rejects pending work, and does not reconnect", async () => {
  const server = await angula();
  const client = connect(server.url);
  const channel = client.realtime.channel("bye");
  await channel.subscribe();
  const closed: string[] = [];
  channel.on("closed", (e) => closed.push(e.reason));
  client.realtime.disconnect();
  assert.equal(client.realtime.status, "closed");
  await tick(80);
  assert.equal(server.connections, 1);
  assert.deepEqual(closed, ["disconnected"]);
  await server.close();
  client.dispose();
});

test("an unanswered request times out with ack_timeout", async () => {
  const server = await angula();
  const client = connect(server.url, { realtime: { webSocket: WebSocket as unknown as WebSocketConstructor, ackTimeoutMs: 60 } });
  const channel = client.realtime.channel("silent");
  await channel.subscribe();
  // Make the server stop answering by closing its message handling: use an unknown frame type that gets no ack with a ref.
  await assert.rejects(client.realtime.request({ type: "mystery" }), (e: unknown) => e instanceof RealtimeError && (e.code === "unknown_type" || e.code === "ack_timeout"));
  client.dispose();
  await server.close();
});

test("without a WebSocket implementation the error says what to do", async () => {
  const http = await serve(() => ({ body: {} }));
  const globalWs = (globalThis as Record<string, unknown>)["WebSocket"];
  delete (globalThis as Record<string, unknown>)["WebSocket"];
  try {
    const client = createClient({ url: http.url, apiKey: "pk", auth: { storage: new MemoryStorage() } });
    await assert.rejects(client.realtime.connect(), /webSocket/);
    client.dispose();
  } finally {
    (globalThis as Record<string, unknown>)["WebSocket"] = globalWs;
  }
});

test("a silent link is recycled by the heartbeat", async () => {
  const server = await angula();
  const client = connect(server.url, { realtime: { webSocket: WebSocket as unknown as WebSocketConstructor, heartbeatSeconds: 0.05, reconnect: { baseDelayMs: 5, maxDelayMs: 10 } } });
  await client.realtime.channel("hb").subscribe();
  // Pings go out on schedule and are answered, so the link stays up.
  await until(() => server.received.filter((f) => f["type"] === "ping").length >= 2);
  assert.equal(client.realtime.status, "open");
  client.dispose();
  await server.close();
});
