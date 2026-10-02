import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Incoming {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  raw: Buffer;
  json: any;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the body as it is, without JSON encoding. */
  text?: string;
  delayMs?: number;
}

export type Handler = (request: Incoming, index: number) => Reply | Promise<Reply> | undefined;

export interface Fake {
  url: string;
  requests: Incoming[];
  server: Server;
  close(): Promise<void>;
}

/** A tiny HTTP server that records every request and answers with whatever `handler` returns. */
const open: Fake[] = [];

/** Close every server a test left open (register with `after(closeAll)`). */
export async function closeAll(): Promise<void> {
  await Promise.all(open.splice(0).map((fake) => fake.close()));
}

export async function serve(handler: Handler): Promise<Fake> {
  const requests: Incoming[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    let json: unknown = undefined;
    if (raw.length && String(req.headers["content-type"] ?? "").includes("json")) {
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        json = undefined;
      }
    }
    const incoming: Incoming = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      raw,
      json,
    };
    const index = requests.push(incoming) - 1;
    const reply = (await handler(incoming, index)) ?? { status: 404, body: "Not found" };
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    const status = reply.status ?? 200;
    if (reply.text !== undefined) {
      res.writeHead(status, { "content-type": "text/plain", "x-request-id": `req-${index}`, ...reply.headers });
      res.end(reply.text);
      return;
    }
    if (reply.body === undefined) {
      res.writeHead(status, { "x-request-id": `req-${index}`, ...reply.headers });
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", "x-request-id": `req-${index}`, ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: Fake = {
    url: `http://127.0.0.1:${port}`,
    requests,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(fake);
  return fake;
}

export const user = (overrides: Record<string, unknown> = {}) => ({
  id: "1",
  email: "ada@example.com",
  username: "ada",
  name: "Ada",
  avatar_url: null,
  email_verified: true,
  email_verified_at: null,
  user_metadata: {},
  app_metadata: {},
  roles: [],
  mfa_enabled: false,
  identities: [],
  created_at: null,
  last_sign_in_at: null,
  ...overrides,
});

let counter = 0;
/** A session response like Akountz's. `expiresIn` is seconds. */
export function sessionBody(expiresIn = 3600, overrides: Record<string, unknown> = {}) {
  counter += 1;
  const nowS = Math.floor(Date.now() / 1000);
  return {
    access_token: `access-${counter}`,
    refresh_token: `refresh-${counter}`,
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: nowS + expiresIn,
    session_id: `sid-${counter}`,
    org: null,
    org_role: null,
    user: user(),
    ...overrides,
  };
}

export const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await tick(5);
  }
}
