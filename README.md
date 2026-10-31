# @pawabase/client

The official TypeScript client for [Pawabase](https://pawabase.com): records, auth, storage,
flows and realtime, with typed errors, safe retries and one shared session.

- **Zero dependencies.** Standard `fetch` and `WebSocket` only. Tested on Node 26 and against a live stack; it uses no Node-only APIs in the library, so browsers and other runtimes with `fetch` should work (bring a `storage` on React Native).
- **Typed end to end.** Generate a `Database` type from your project and resource names, rows, inserts and filters are checked.
- **Built for the failures.** Rate limits and `502/503/504` are retried with backoff and `Retry-After`; refresh tokens are exchanged once, even from many tabs; errors are classes, not strings.
- **ESM and CommonJS**, with types.

```bash
npm install @pawabase/client
```

```ts
import { createClient } from "@pawabase/client";

const pawabase = createClient({
  url: "https://api.example.com",       // your gateway
  apiKey: "pb_pk_…",                    // a publishable key
});

await pawabase.auth.signInWithPassword({ email: "ada@example.com", password: "…" });

const { data, total } = await pawabase
  .from("posts")
  .eq("status", "live")
  .order("created_at", "desc")
  .perPage(20);
```

## Contents

- [Keys](#keys) · [Records](#records) · [Auth](#auth) · [Storage](#storage) · [Flows and routes](#flows-and-routes) · [Realtime](#realtime)
- [Managing an environment](#managing-an-environment-secret-key) · [Types](#types) · [Errors](#errors) · [Retries and timeouts](#retries-and-timeouts) · [Servers and SSR](#servers-and-ssr) · [Testing](#testing-your-app)

## Keys

Every request carries your project key in the `apikey` header; a signed-in user's token goes in
`Authorization` automatically.

| Key | Where | What it does |
| --- | --- | --- |
| `pb_pk_…` publishable | Browsers, mobile apps | Anonymous role. **Policies apply.** |
| `pb_sk_…` secret | Servers only | Bypasses every policy. |

A secret key in a browser is refused (`ConfigError`), because anyone can read it. Set
`dangerouslyAllowBrowser: true` only if you know why you must.

## Records

```ts
const posts = pawabase.from("posts");

await posts.create({ title: "Hello" });                       // → the created row
await posts.get(1, { expand: ["author"] });                   // 404 → NotFoundError
await posts.maybeGet(1);                                      // 404 → null
await posts.update(1, { title: "Hi" });                       // PATCH
await posts.delete(1);
```

### Queries

A query is built with chained methods, is immutable (reuse a base query freely), and runs when awaited.

```ts
const live = pawabase.from("posts").eq("status", "live");

await live.gte("views", 100).order("views", "desc").perPage(50).page(2);
await live.like("title", "Intro*").first();                   // Row | null
await live.count();                                           // number
await live.all({ maxRecords: 1000 });                         // every row, across pages
for await (const post of live) { /* lazily, page by page */ }

await pawabase.from("posts").where({ status: "live", views: { gte: 10 }, org_id: null });
await pawabase.from("posts").in("id", [1, 2, 3]).select("id", "title").expand("author");
```

| Method | Server operator |
| --- | --- |
| `eq` `neq` `gt` `gte` `lt` `lte` | `eq` `neq` `gt` `gte` `lt` `lte` |
| `like` `ilike` | `like` `ilike` (`*` or `%` match any run) |
| `in` `notIn` | `in` `nin` |
| `is` `isNot` | `is` `isnot` (`null`, `true`, `false`) |

The client protects you from three server behaviours that would otherwise return wrong data without an error:

1. **One filter per field.** The server keeps only the last filter on a repeated field, so a two-sided range
   (`gte` + `lte` on one field) cannot be written. The client throws `InvalidQueryError` instead of dropping a bound.
2. **Booleans.** `filter[flag]=eq.false` matches the wrong rows. `eq(col, false)` is sent as `is.false`.
3. **`in` lists are split on commas**, so a value containing a comma is refused.

`page.total` is `null` when a per-row policy makes the count unknowable; pages can then be short or empty with
more behind them, and `all()` stops at the first empty page (`stopAfterEmptyPages` to be more patient).
`select()` leaves unselected columns in the row as `null`.

`createMany(rows)` creates a few at a time and returns `{ created, failed }`. It is **not atomic.**

## Auth

```ts
const { session, verificationRequired } = await pawabase.auth.signUp({ email, password, data: { plan: "free" } });

const result = await pawabase.auth.signInWithPassword({ email, password });
if (result.status === "mfa_required") await result.verify(codeFromAuthenticator);

pawabase.auth.onAuthStateChange((event, session) => { /* INITIAL_SESSION | SIGNED_IN | TOKEN_REFRESHED | USER_UPDATED | SIGNED_OUT */ });

await pawabase.auth.getUser();
await pawabase.auth.updateUser({ name: "Ada", data: { theme: "dark" } });
await pawabase.auth.signOut();                 // { scope: "global" } ends every session
```

**The session is managed for you.** It is stored (`localStorage` in browsers, memory elsewhere; pass `auth.storage`
for anything else), refreshed shortly before it expires, and refreshed **once** at a time. Akountz rotates refresh tokens and
treats a reused one as theft, so concurrent refreshes would sign the user out: concurrent requests share one exchange,
and across tabs the Web Locks API serialises it where the browser has it (tab-to-tab behaviour is covered by a simulated test, not a real browser). A `401` on a request triggers one refresh and a replay.

Also: `signInWithMagicLink` / `verifyMagicLink`, `requestPasswordReset` / `resetPassword`, `verifyEmail`,
`resendVerification`, `confirmEmailChange`, `mfa.*` (enroll, verify, disable, recovery codes), `sessions.*`,
`orgs.*` (members, invitations, teams), `devices.*`, `apiKeys.*` (keys a user makes for themselves), `machine.token()` and `asMachine({ clientId, clientSecret })` (a service or AI agent signing in with its client id and key), `exchangeCode(code)`, `switchOrg(slug)`, `settings()`.

Also: **guest sessions** (`signInAnonymously()`, then `upgradeAnonymous({ email, password })` keeps what the guest made), **emailed codes**
(`sendEmailCode({ email })`, `verifyEmailCode({ email, code })`), **passkeys** (in a browser `auth.passkeys.register()` and
`auth.passkeys.signIn()` do the whole WebAuthn ceremony; `list`, `remove`, and the `request…` / `finish…` pairs are there for native apps and tests),
`issueToken("billing")` for a short-lived token for another service, and `jwks()` for the public keys that verify it.

**Social sign-in** needs the `environment` in the options, because the provider URL names it (a publishable key only: a secret key is refused):

```ts
const pawabase = createClient({ url, apiKey, environment: "production" });
pawabase.auth.signInWithOAuth("github", { redirectTo: location.origin });  // redirects
// On return, the tokens in the URL fragment are picked up automatically (detectSessionInUrl).
```

## Storage

```ts
const avatars = pawabase.storage.from("avatars");

await avatars.upload("u1/me.png", file);                       // Blob, File, bytes, string or stream
const blob = await avatars.download("u1/me.png");
const { files, prefixes, cursor } = await avatars.list({ prefix: "u1/" });
for await (const file of avatars.listAll({ prefix: "u1/" })) { … }
await avatars.remove("u1/me.png");

avatars.getPublicUrl("u1/me.png");                             // public bucket, for <img src>
const { url } = await avatars.createSignedUrl("u1/me.png", { expiresIn: 300 });
const slot = await avatars.createSignedUploadUrl("u1/new.png", { contentType: "image/png", maxBytes: 1e6 });
await avatars.uploadToSignedUrl(slot.url, file);               // sends no key: the URL is the credential
```

## Flows and routes

```ts
await pawabase.flows.run("whoami");                                          // the flow's response body
await pawabase.routes.post("checkout/start", { cart: 1 }, { query: { dry: true } });
await pawabase.request("GET", "/v1/anything");                               // raw, with auth and retries
```

## Realtime

```ts
const room = pawabase.realtime.channel<{ text: string }>("chat:lobby", { presence: { name: "Ada" }, replay: 50 });

room.on("message", (m) => console.log(m.from, m.payload.text));
room.onEvent("typing", (m) => …);
room.on("presence", ({ joins, leaves, members }) => …);

await room.subscribe();                      // rejects with RealtimeError("forbidden") if the channel's rule refuses
await room.send("message", { text: "hi" });  // resolves when the server accepted it
await room.track({ name: "Ada", typing: true });
await room.history(20);
for await (const m of room) { … }            // or iterate
await room.unsubscribe();
```

The connection reconnects with backoff, rejoins every channel, and with `replay: n` fetches what you missed
and delivers it once (messages are de-duplicated by id). Pings run every 25 s and a silent link is recycled.
A refreshed access token is sent to the open socket without reconnecting.

No socket needed: `for await (const frame of pawabase.realtime.stream(["chat:lobby"])) …` listens over Server-Sent Events (stop with `break` or an
`AbortSignal`), and `pawabase.realtime.publish(...)` sends. Channel rules and dashboards are managed with `manage(client).realtimeChannels` and
`manage(client).dashboards`.

On Node 20 there is no global `WebSocket`; pass one: `realtime: { webSocket: WebSocket }` from the `ws` package.

HTTP counterparts need no socket: `realtime.publish(channel, event, payload)`, `realtime.presence(channel)`, `realtime.history(channel)`.

## Managing an environment (secret key)

Everything Studio does is available to your servers and scripts with an environment's secret key (`pb_sk_…`), as two subpath imports that stay out of
your browser bundle unless you import them:

```ts
import { createClient } from "@pawabase/client";
import { manage } from "@pawabase/client/manage";
import { admin } from "@pawabase/client/admin";

const pawabase = createClient({ url, apiKey: process.env.PAWABASE_SECRET_KEY!, environment: "production" });
const m = manage(pawabase);

await m.secrets.set("STRIPE_KEY", "sk_live_…");
await m.firewall.ban("203.0.113.7", { seconds: 3600 });
await m.jobs.replay({ job: "send_mail", sinceMinutes: 60, dryRun: true });
await m.backups.snapshot("before-launch");
await manage(pawabase, "staging").flows.list();            // the same API for another environment the key may manage

const a = admin(pawabase);                                  // the people who sign in to your application
await a.users.create({ email: "ada@example.com", password: "…", roles: ["editor"] });
await a.users.update(userId, { disabled: true });
await a.orgs.addMember("acme", { email: "ada@example.com", role: "admin" });
```

`manage()` groups the platform by what you are doing: **data** (`resources`, `schema`, `policies`, `schemas`, `transformers`, `routes`, `database`, `runtime`),
**automation** (`flows`, `schedules`, `subscriptions`, `events`, `webhooks`, `inboundHooks`, `jobs`), **files and mail** (`buckets`, `cache`, `mail`,
`mailTemplates`), **access** (`keys`, `secrets`, `domains`, `firewall`), **observe** (`observability`, `alarms`, `statusPage`, `health`) and **lifecycle**
(`environments`, `releases`, `backups`). Definitions (`flows`, `policies`, `webhooks`…) share `list`, `getOne`, `create`, `replace` and `remove`, and take
`{ branch }` to work on a feature branch. `admin()` has `users`, `roles`, `orgs`, `invitations`, `sessions`, `apiKeys`, `machines`, `devices`, `privacy` and `insight`
(events, statistics, identity backup, hosted pages). `admin().users` also reads a person's `activity()` and `timeline()` (sign-ins, account changes and requests) and handles data requests with `exportData()` and `eraseData()`. Both refuse a publishable key, and a key manages only its own environment.

## Types

Generate a `Database` type from your environment's OpenAPI document:

```bash
npx pawabase-types --url https://api.example.com --project acme --env production --out src/pawabase.types.ts
# or, with the document saved from Studio's API Explorer:
npx pawabase-types --file openapi.json --out src/pawabase.types.ts
```

```ts
import type { Database } from "./pawabase.types";
const pawabase = createClient<Database>({ url, apiKey });

await pawabase.from("posts").create({ title: "ok" });      // checked
await pawabase.from("posts").create({ views: 3 });         // error: title is required
pawabase.from("posts").eq("nope", 1);                      // error: no such column
```

The gateway serves the document when the environment's **public docs** setting is on. Run `pawabase-types --check` in CI to catch drift.
Relations you `expand` are not in the document; add them to a row type yourself:
`pawabase.resource<Post & { author: Author }>("posts")`.

## Errors

Everything thrown is a `PawabaseError`. Server answers are `ApiError`s (the server sends several body shapes, normalised here):

| Class | When | Useful fields |
| --- | --- | --- |
| `AuthenticationError` | `401`: bad key (`code: "invalid_api_key"`), signed out, expired | |
| `PermissionError` | `403` | `policy`: the refusing policy, when the server names it |
| `NotFoundError` | `404`: no record, or a read policy hides it | |
| `ValidationError` | `422` | `issues`, `fieldError("email")`, `byField()` |
| `ConflictError` | `409` | |
| `RateLimitError` | `429` | `retryAfter` (seconds) |
| `ServerError` | `5xx` | |
| `NetworkError` / `TimeoutError` / `AbortError` | no response | |
| `ConfigError` / `InvalidQueryError` / `RealtimeError` | misuse, refused query, socket refusals | |

Every `ApiError` has `status`, `code`, `message`, `details`, `body` and **`requestId`**: quote it to find the request in Studio → Observability.

```ts
try { await pawabase.from("posts").create(input); }
catch (e) {
  if (e instanceof ValidationError) showFieldErrors(e.byField());
  else if (e instanceof PermissionError) console.warn(`refused by policy ${e.policy}`);
  else throw e;
}
```

## Retries and timeouts

| Situation | Retried? |
| --- | --- |
| `429` | Yes, any method (it is answered before a handler runs), waiting `Retry-After` up to `maxRetryAfterMs` (30 s), else surfaced |
| `502` `503` `504`, network failure, timeout | Yes for `GET` `PUT` `DELETE`; **not** for `POST` / `PATCH` unless `idempotent: true` |
| `500`, `4xx` | No |
| Token refresh | Never retried on a network failure: a replayed refresh token looks like theft |

Defaults: 2 retries, full-jitter backoff 300 ms → 8 s, 30 s timeout per attempt.
Configure with `retry`, `timeoutMs`; every call also takes an `AbortSignal` (`query.withOptions({ signal })`, `{ signal }`).

`hooks: { onRequest, onResponse, onRetry, onError }` observe traffic (API keys and tokens are masked).

## Servers and SSR

```ts
// A server acting for the signed-in user of this request: no session, no refresh, no storage.
const asUser = pawabase.asUser(tokenFromTheRequest);
await asUser.from("tasks").all();

// A server acting as itself, bypassing policies.
const server = createClient({ url, apiKey: process.env.PAWABASE_SECRET_KEY! });
```

## Testing your app

Pass your own `fetch`, or point `url` at a local stack. `auth.storage` takes any `{ getItem, setItem, removeItem }`,
and `client.dispose()` stops timers and the socket.

## Development

```bash
npm install
npm test                                   # unit tests against local fake servers
PAWABASE_LIVE_CONFIG=/tmp/pb/config.json npm test   # plus contract tests against a real stack
```

The live config (`url`, `project`, `environment`, `publishable`, `secret`) is written by `scripts/live-provision.py`
after the stack is up (`scripts/dev.sh`). Without it the live tests are skipped.
