export { PawabaseClient, createClient } from "./client.js";
export type { ClientOptions, DatabaseShape } from "./client.js";

export { AiClient } from "./ai.js";
export { AgentsClient, KnowledgeClient } from "./agents.js";
export type { AgentEvent, AgentRun, AgentRunOptions, AgentRunStatus, KnowledgeDocument, KnowledgeHit } from "./agents.js";
export type { AiModelInfo, ChatCompletion, ChatMessage, ChatOptions } from "./ai.js";
export { AuthClient } from "./auth.js";
export type {
  AuthChangeEvent,
  AuthListener,
  AuthOptions,
  IssuedToken,
  MachineToken,
  Passkey,
  PasskeyChallenge,
  SignInResult,
  SignUpResult,
  UpdateUserInput,
  UrlSessionResult,
} from "./auth.js";
export { CaptchaClient, captchaChallengeOf, isCaptchaError, solveChallenge } from "./captcha.js";
export type { CaptchaAction, CaptchaChallenge, CaptchaOptions, CaptchaPass, CaptchaProvider, CaptchaVerification, PrepareResult } from "./captcha.js";
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

export { FlowsClient, RoutesClient } from "./functions.js";
export type { CallOptions, RouteOptions } from "./functions.js";

export { BucketClient, StorageClient } from "./files.js";
export type { ImageTransform, ShareLinkOptions, TransferOptions, UploadBody, UploadOptions } from "./files.js";

export { LiveQuery, RealtimeChannel, RealtimeClient } from "./realtime.js";
export type {
  ChannelEvents,
  ChannelOptions,
  LiveQueryOptions,
  LiveResult,
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
