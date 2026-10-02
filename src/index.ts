export { PawabaseClient, createClient } from "./client.js";
export type { ClientOptions, DatabaseShape } from "./client.js";

export { AuthClient } from "./auth.js";
export type {
  AuthChangeEvent,
  AuthListener,
  AuthOptions,
  SignInResult,
  SignUpResult,
  UpdateUserInput,
  UrlSessionResult,
} from "./auth.js";
export { MemoryStorage } from "./session-store.js";
export type { SessionStorage } from "./session-store.js";

export { QueryBuilder, ResourceClient } from "./data.js";
export type {
  AnyRow,
  Condition,
  CreateManyResult,
  FilterOp,
  IterateOptions,
  QueryOptions,
  ReadOptions,
  ResourceTypes,
} from "./data.js";

export { FlowsClient, FunctionsClient, RoutesClient } from "./functions.js";
export type { CallOptions, RouteOptions } from "./functions.js";

export { BucketClient, StorageClient } from "./files.js";
export type { TransferOptions, UploadBody, UploadOptions } from "./files.js";

export { RealtimeChannel, RealtimeClient } from "./realtime.js";
export type {
  ChannelEvents,
  ChannelOptions,
  PresenceChange,
  RealtimeOptions,
  RealtimeStatus,
  WebSocketConstructor,
  WebSocketLike,
} from "./realtime.js";

export { HttpClient } from "./http.js";
export type { FetchLike, Hooks, RequestInfo, RequestOptions, ResponseInfo, RetryOptions, TokenProvider } from "./http.js";

export * from "./errors.js";
export type * from "./types.js";
export { VERSION } from "./version.js";
export { generateTypes } from "./typegen.js";
export type { TypegenOptions } from "./typegen.js";
