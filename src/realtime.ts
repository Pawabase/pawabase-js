import type { AuthClient } from "./auth.js";
import { ConfigError, RealtimeError } from "./errors.js";
import type { HttpClient } from "./http.js";
import type { ChannelMessage, PresenceMember } from "./types.js";
import { backoff, encodePath, sleep } from "./util.js";

export type RealtimeStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The slice of the WebSocket API the client uses; the browser's, Node's and `ws` all fit. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface RealtimeOptions {
  /** A WebSocket implementation. Default: the global one (browsers, Node 22+). On older Node pass `ws`. */
  webSocket?: WebSocketConstructor;
  /** Seconds between pings. Default `25`. The connection is recycled after two silent intervals. */
  heartbeatSeconds?: number;
  /** Milliseconds to wait for the server to acknowledge a request. Default `10000`. */
  ackTimeoutMs?: number;
  /** Milliseconds to wait for the connection to open. Default `10000`. */
  connectTimeoutMs?: number;
  /** Reconnect after a drop. `false` to stay closed. */
  reconnect?: false | { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  /** Called with protocol-level surprises (unknown frames, invalid JSON). */
  onProtocolError?: (detail: string) => void;
}

export interface ChannelOptions {
  /** Your presence data: shown to everyone on the channel while you are subscribed. Needs presence enabled by the channel's rule. */
  presence?: Record<string, unknown>;
  /**
   * After a reconnect, fetch this many recent messages and deliver the ones you missed
   * (de-duplicated by id). `0`/omitted: only messages sent while connected are delivered.
   */
  replay?: number;
}

export interface PresenceChange<M> {
  joins: PresenceMember<M>[];
  leaves: PresenceMember<M>[];
  /** Everyone present after the change. */
  members: PresenceMember<M>[];
}

export interface ChannelEvents<T, M> {
  message: ChannelMessage<T>;
  presence: PresenceChange<M>;
  subscribed: undefined;
  /** The channel stopped receiving: unsubscribed, or the connection was lost (it resubscribes by itself when it can). */
  closed: { reason: string };
  error: RealtimeError;
}

type Handler<V> = (value: V) => void;

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  expect: "ack" | "history";
}

const OPEN = 1;
const FATAL_CLOSE = new Set([4001]);
const SEEN_LIMIT = 1000;

export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private currentStatus: RealtimeStatus = "idle";
  private readonly channels = new Map<string, RealtimeChannel<any, any>>();
  private readonly pending = new Map<string, Pending>();
  private readonly statusListeners = new Set<Handler<RealtimeStatus>>();
  private refs = 0;
  private attempts = 0;
  private manual = false;
  private connecting: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = 0;
  private triedRefresh = false;
  private authSubscription: { unsubscribe: () => void } | null = null;
  /** The server's id for this connection, once welcomed. */
  connectionId: string | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthClient | null,
    private readonly options: RealtimeOptions & { project?: string | undefined; environment?: string | undefined } = {},
  ) {}

  get status(): RealtimeStatus {
    return this.currentStatus;
  }

  onStatusChange(handler: Handler<RealtimeStatus>): () => void {
    this.statusListeners.add(handler);
    return () => void this.statusListeners.delete(handler);
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const handler of [...this.statusListeners]) {
      try {
        handler(status);
      } catch {
        /* observers must not break the connection */
      }
    }
  }

  // ── channels ──────────────────────────────────────────────────────────

  /**
   * A channel by name. Asking twice returns the same object, so listeners are shared.
   * Channel names are authorised by the project's realtime rules.
   */
  channel<T = unknown, M = Record<string, unknown>>(name: string, options: ChannelOptions = {}): RealtimeChannel<T, M> {
    let channel = this.channels.get(name) as RealtimeChannel<T, M> | undefined;
    if (!channel) {
      channel = new RealtimeChannel<T, M>(this, name, options);
      this.channels.set(name, channel);
    } else if (options.presence || options.replay !== undefined) {
      channel.configure(options);
    }
    return channel;
  }

  /** Forget a channel object once it is unsubscribed. */
  forget(name: string): void {
    this.channels.delete(name);
  }

  // ── connection ────────────────────────────────────────────────────────

  private url(token: string | null): string {
    const base = new URL(this.http.config.baseUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/realtime/v1/socket`;
    base.search = "";
    base.searchParams.set("apikey", this.http.config.apiKey);
    if (token) base.searchParams.set("token", token);
    if (this.options.project) base.searchParams.set("project_id", this.options.project);
    if (this.options.environment) base.searchParams.set("environment", this.options.environment);
    return base.toString();
  }

  /** Open the connection (channels do this for you). Resolves once the server has welcomed it. */
  connect(): Promise<void> {
    if (this.currentStatus === "open") return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.manual = false;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const Impl = this.options.webSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!Impl) {
      throw new ConfigError(
        "No WebSocket implementation found. Pass `realtime: { webSocket }` to createClient (for example the `ws` package on Node 20).",
      );
    }
    this.setStatus(this.attempts > 0 ? "reconnecting" : "connecting");
    const token = (await this.auth?.getAccessToken().catch(() => null)) ?? null;
    const socket = new Impl(this.url(token));
    this.socket = socket;
    this.lastActivity = Date.now();
    const timeoutMs = this.options.connectTimeoutMs ?? 10_000;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RealtimeError("connect_timeout", `The realtime connection did not open within ${timeoutMs} ms.`));
        try {
          socket.close(4000, "connect timeout");
        } catch {
          /* already closed */
        }
      }, timeoutMs);
      let welcomed = false;
      socket.onmessage = (event) => {
        this.lastActivity = Date.now();
        const frame = this.parse(event.data);
        if (!frame) return;
        if (!welcomed && frame["type"] === "welcome") {
          welcomed = true;
          clearTimeout(timer);
          this.connectionId = typeof frame["connection_id"] === "string" ? frame["connection_id"] : null;
          socket.onmessage = (next) => this.onMessage(next.data);
          this.attempts = 0;
          this.triedRefresh = false;
          this.setStatus("open");
          this.startHeartbeat();
          this.watchAuth();
          void this.resubscribe();
          resolve();
          return;
        }
        this.onMessage(event.data);
      };
      socket.onerror = () => {
        /* the close event follows with the code */
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        if (!welcomed) {
          reject(new RealtimeError(`closed_${event.code}`, event.reason || `The connection closed (${event.code}) before it opened.`));
        }
        this.onClose(event.code, event.reason ?? "", welcomed);
      };
    });
  }

  /** Close the connection and stop reconnecting. Channels keep their listeners and rejoin on the next `connect()`. */
  disconnect(): void {
    this.manual = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.authSubscription?.unsubscribe();
    this.authSubscription = null;
    const socket = this.socket;
    this.socket = null;
    this.failPending(new RealtimeError("closed", "The realtime connection was closed."));
    for (const channel of this.channels.values()) channel.markClosed("disconnected");
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close(1000, "client closed");
      } catch {
        /* already closed */
      }
    }
    this.attempts = 0;
    this.setStatus("closed");
  }

  private onClose(code: number, reason: string, wasOpen: boolean): void {
    this.stopHeartbeat();
    this.socket = null;
    this.failPending(new RealtimeError("closed", "The realtime connection closed."));
    for (const channel of this.channels.values()) channel.markClosed(reason || `closed (${code})`);
    if (this.manual) return;
    if (FATAL_CLOSE.has(code)) {
      this.setStatus("closed");
      return;
    }
    if (code === 4003 && !this.triedRefresh && this.auth) {
      // The token was refused: refresh it once, then try again.
      this.triedRefresh = true;
      void this.auth
        .refreshSession()
        .then(() => this.scheduleReconnect(0))
        .catch(() => this.setStatus("closed"));
      return;
    }
    if (code === 4003) {
      this.setStatus("closed");
      return;
    }
    void wasOpen;
    this.scheduleReconnect();
  }

  private scheduleReconnect(forcedDelay?: number): void {
    const policy = this.options.reconnect;
    if (policy === false) {
      this.setStatus("closed");
      return;
    }
    const maxAttempts = policy?.maxAttempts ?? Infinity;
    if (this.attempts >= maxAttempts) {
      this.setStatus("closed");
      return;
    }
    const delay =
      forcedDelay ?? backoff(this.attempts, { baseDelayMs: policy?.baseDelayMs ?? 500, maxDelayMs: policy?.maxDelayMs ?? 15_000 });
    this.attempts += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connecting = this.open()
        .catch(() => {
          // open() rejected without a close event reaching onClose (rare); try again.
          if (!this.manual && !this.socket) this.scheduleReconnect();
        })
        .finally(() => {
          this.connecting = null;
        });
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = (this.options.heartbeatSeconds ?? 25) * 1000;
    this.heartbeat = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== OPEN) return;
      if (Date.now() - this.lastActivity > interval * 2 + 1000) {
        // Nothing, not even a pong: the link is dead without having closed.
        try {
          socket.close(4000, "heartbeat timeout");
        } catch {
          /* already closed */
        }
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* the close handler will follow */
      }
    }, interval);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Tell the server about a refreshed (or removed) token without reconnecting. */
  private watchAuth(): void {
    if (!this.auth || this.authSubscription) return;
    this.authSubscription = this.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" || this.currentStatus !== "open") return;
      void this.request({ type: "auth", token: session?.access_token ?? null }).catch(() => undefined);
    });
  }

  private async resubscribe(): Promise<void> {
    for (const channel of [...this.channels.values()]) {
      if (channel.wantsJoin) await channel.rejoin().catch(() => undefined);
    }
  }

  // ── messages ──────────────────────────────────────────────────────────

  private parse(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "string") {
      this.options.onProtocolError?.("a binary frame arrived; Pawabase sends JSON text");
      return null;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    this.options.onProtocolError?.(`an invalid frame arrived: ${raw.slice(0, 120)}`);
    return null;
  }

  private onMessage(raw: unknown): void {
    this.lastActivity = Date.now();
    const frame = this.parse(raw);
    if (!frame) return;
    switch (frame["type"]) {
      case "ack": {
        const pending = this.take(frame["ref"]);
        if (!pending) return;
        if (frame["ok"] === false) {
          pending.reject(
            new RealtimeError(String(frame["error"] ?? "error"), String(frame["reason"] ?? frame["error"] ?? "The request was refused.")),
          );
        } else if (pending.expect === "ack") pending.resolve(frame);
        return;
      }
      case "history": {
        const pending = this.take(frame["ref"]);
        pending?.resolve(frame);
        return;
      }
      case "message": {
        this.channels.get(String(frame["channel"]))?.deliver(frame as unknown as ChannelMessage);
        return;
      }
      case "presence_state": {
        this.channels.get(String(frame["channel"]))?.setPresence((frame["members"] as PresenceMember[]) ?? []);
        return;
      }
      case "presence_diff": {
        this.channels
          .get(String(frame["channel"]))
          ?.applyPresence((frame["joins"] as PresenceMember[]) ?? [], (frame["leaves"] as PresenceMember[]) ?? []);
        return;
      }
      case "pong":
      case "welcome":
        return;
      case "error":
        this.options.onProtocolError?.(`the server reported: ${String(frame["error"])}`);
        return;
      default:
        this.options.onProtocolError?.(`an unknown frame arrived: ${String(frame["type"])}`);
    }
  }

  private take(ref: unknown): Pending | undefined {
    if (typeof ref !== "string") return undefined;
    const pending = this.pending.get(ref);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(ref);
    return pending;
  }

  private failPending(error: unknown): void {
    for (const [ref, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(ref);
    }
  }

  /** Send a frame and wait for its acknowledgement (or, for `history`, its answer). */
  request(frame: Record<string, unknown>, expect: "ack" | "history" = "ack"): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      return Promise.reject(new RealtimeError("not_connected", "The realtime connection is not open."));
    }
    const ref = String(++this.refs);
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.ackTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new RealtimeError("ack_timeout", `The server did not answer within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(ref, { resolve, reject, timer, expect });
      try {
        socket.send(JSON.stringify({ ...frame, ref }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(ref);
        reject(new RealtimeError("send_failed", "Could not send on the realtime connection.", { cause: error }));
      }
    });
  }

  // ── HTTP counterparts (no socket needed) ──────────────────────────────

  /** Publish from anywhere, without a socket. The channel's `publish` rule applies. */
  publish(channel: string, event: string, payload?: unknown): Promise<{ id: string; channel: string; event: string }> {
    return this.http.request({ method: "POST", path: "/realtime/v1/publish", body: { channel, event, payload } });
  }

  /** Who is on a channel right now. */
  async presence<M = Record<string, unknown>>(channel: string): Promise<PresenceMember<M>[]> {
    return (
      await this.http.request<{ members: PresenceMember<M>[] }>({ path: `/realtime/v1/channels/${encodePath(channel)}/presence` })
    ).members;
  }

  /** Recent messages on a channel, oldest first. */
  async history<T = unknown>(channel: string, limit = 50): Promise<ChannelMessage<T>[]> {
    return (
      await this.http.request<{ messages: ChannelMessage<T>[] }>({
        path: `/realtime/v1/channels/${encodePath(channel)}/history`,
        query: { limit },
      })
    ).messages;
  }

  /**
   * Wait until the socket is really open, or `ms` pass: after a drop the status can lag the
   * socket for a moment, and a reconnect takes a few. Connects first when idle or closed.
   */
  async whenOpen(ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.currentStatus === "open" && this.socket?.readyState === OPEN) return;
      if (Date.now() > deadline) throw new RealtimeError("not_connected", "The realtime connection did not open in time.");
      if (this.currentStatus === "idle" || (this.currentStatus === "closed" && !this.manual)) await this.connect().catch(() => undefined);
      else await sleep(20);
    }
  }
}

/** One named channel: receive messages and presence, publish, and see who is here. */
export class RealtimeChannel<T = unknown, M = Record<string, unknown>> {
  private readonly handlers = new Map<string, Set<Handler<any>>>();
  private options: ChannelOptions;
  private joined = false;
  private joining: Promise<void> | null = null;
  private wanted = false;
  private readonly members = new Map<string, PresenceMember<M>>();
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly queue: ChannelMessage<T>[] = [];
  private readonly waiters: Array<(value: IteratorResult<ChannelMessage<T>>) => void> = [];
  private ended = false;

  constructor(
    private readonly client: RealtimeClient,
    readonly name: string,
    options: ChannelOptions,
  ) {
    this.options = { ...options };
  }

  /** @internal */
  configure(options: ChannelOptions): void {
    this.options = { ...this.options, ...options };
  }

  /** True while the channel is subscribed on the open connection. */
  get subscribed(): boolean {
    return this.joined;
  }

  /** @internal Whether the channel should rejoin after a reconnect. */
  get wantsJoin(): boolean {
    return this.wanted;
  }

  /** Listen to `message`, `presence`, `subscribed`, `closed` or `error`. Returns a function that stops listening. */
  on<K extends keyof ChannelEvents<T, M>>(event: K, handler: Handler<ChannelEvents<T, M>[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => void set.delete(handler);
  }

  /** Listen to messages with one event name only. */
  onEvent(event: string, handler: Handler<ChannelMessage<T>>): () => void {
    return this.on("message", (message) => {
      if (message.event === event) handler(message);
    });
  }

  private emit<K extends keyof ChannelEvents<T, M>>(event: K, value: ChannelEvents<T, M>[K]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try {
        handler(value);
      } catch {
        /* a listener must not break delivery */
      }
    }
  }

  /**
   * Start receiving. Connects first if needed. Rejects with a {@link RealtimeError} when the
   * channel's rule refuses (`code: "forbidden"`). Safe to call twice.
   */
  async subscribe(): Promise<this> {
    this.ended = false;
    if (this.joined) return this;
    if (!this.joining) {
      this.joining = (async () => {
        await this.client.connect();
        await this.join(false);
        // Only a channel that joined is rejoined after a reconnect: the client rejoins
        // on its own at welcome, and must not race this first join.
        this.wanted = true;
      })().finally(() => {
        this.joining = null;
      });
    }
    await this.joining;
    return this;
  }

  /** @internal Rejoin after a reconnect. */
  async rejoin(): Promise<void> {
    await this.join(true);
  }

  private async join(rejoining: boolean): Promise<void> {
    try {
      await this.client.request({
        type: "subscribe",
        channel: this.name,
        ...(this.options.presence ? { presence: this.options.presence } : {}),
      });
    } catch (error) {
      if (error instanceof RealtimeError) this.emit("error", error);
      throw error;
    }
    this.joined = true;
    this.emit("subscribed", undefined);
    if (rejoining && (this.options.replay ?? 0) > 0) {
      const history = await this.history(this.options.replay).catch(() => [] as ChannelMessage<T>[]);
      for (const message of history) this.deliver(message);
    }
  }

  /** Stop receiving. Pending iterators end. */
  async unsubscribe(): Promise<void> {
    this.wanted = false;
    if (this.joined) {
      await this.client.request({ type: "unsubscribe", channel: this.name }).catch(() => undefined);
    }
    this.joined = false;
    this.members.clear();
    this.end("unsubscribed");
    this.client.forget(this.name);
  }

  /** Publish to the channel over the socket. Resolves with the message id once the server accepted it. */
  async send(event: string, payload?: T): Promise<{ id: string }> {
    await this.client.whenOpen();
    const ack = await this.client.request({ type: "publish", channel: this.name, event, payload });
    return { id: String(ack["id"] ?? "") };
  }

  /** Set the presence data others see for you. Subscribe first. */
  async track(meta: Record<string, unknown>): Promise<void> {
    this.options = { ...this.options, presence: meta };
    await this.client.whenOpen();
    await this.client.request({ type: "presence", channel: this.name, meta });
  }

  /** Recent messages, oldest first. */
  async history(limit = 50): Promise<ChannelMessage<T>[]> {
    await this.client.whenOpen();
    const reply = await this.client.request({ type: "history", channel: this.name, limit }, "history");
    return (reply["messages"] as ChannelMessage<T>[] | undefined) ?? [];
  }

  /** Who is on the channel now, as last told by the server. Empty unless presence is enabled for it. */
  presenceState(): PresenceMember<M>[] {
    return [...this.members.values()];
  }

  // ── delivery (called by the client) ───────────────────────────────────

  /** @internal */
  deliver(message: ChannelMessage): void {
    if (message.id) {
      if (this.seen.has(message.id)) return;
      this.seen.add(message.id);
      this.order.push(message.id);
      if (this.order.length > SEEN_LIMIT) this.seen.delete(this.order.shift() as string);
    }
    const typed = message as ChannelMessage<T>;
    this.emit("message", typed);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: typed, done: false });
    else {
      this.queue.push(typed);
      if (this.queue.length > 1000) this.queue.shift();
    }
  }

  /** @internal */
  setPresence(list: PresenceMember[]): void {
    this.members.clear();
    for (const member of list as PresenceMember<M>[]) this.members.set(member.presence_ref, member);
    this.emit("presence", { joins: [...this.members.values()], leaves: [], members: this.presenceState() });
  }

  /** @internal */
  applyPresence(joins: PresenceMember[], leaves: PresenceMember[]): void {
    for (const member of leaves as PresenceMember<M>[]) this.members.delete(member.presence_ref);
    for (const member of joins as PresenceMember<M>[]) this.members.set(member.presence_ref, member);
    this.emit("presence", {
      joins: joins as PresenceMember<M>[],
      leaves: leaves as PresenceMember<M>[],
      members: this.presenceState(),
    });
  }

  /** @internal The connection dropped; the channel will rejoin by itself if it can. */
  markClosed(reason: string): void {
    if (!this.joined) return;
    this.joined = false;
    this.members.clear();
    this.emit("closed", { reason });
  }

  private end(reason: string): void {
    this.ended = true;
    this.emit("closed", { reason });
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  /** Iterate messages: `for await (const message of channel) { … }`. Ends on `unsubscribe()`. */
  [Symbol.asyncIterator](): AsyncIterator<ChannelMessage<T>> {
    return {
      next: () => {
        const ready = this.queue.shift();
        if (ready) return Promise.resolve({ value: ready, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async () => {
        await this.unsubscribe();
        return { value: undefined, done: true };
      },
    };
  }
}
