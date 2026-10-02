/** Shapes the platform sends. They keep the wire's `snake_case` names, so what you see in Studio and the docs is what you read in code. */

export interface Identity {
  id: number;
  provider: string;
  email: string | null;
  last_sign_in_at: string | null;
}

export interface User {
  id: string;
  email: string;
  username: string;
  name: string;
  avatar_url: string | null;
  email_verified: boolean;
  email_verified_at: string | null;
  /** Profile data the user may edit. Never trust it for authorization. */
  user_metadata: Record<string, unknown>;
  /** Data only the application (a secret key or Studio) can edit. */
  app_metadata: Record<string, unknown>;
  roles: string[];
  mfa_enabled: boolean;
  identities: Identity[];
  created_at: string | null;
  last_sign_in_at: string | null;
  /** The assurance level of the current session: `aal1` (password) or `aal2` (second factor). Only on `getUser()`. */
  aal?: string | null;
  /** Only on `getUser()`. */
  session_id?: string | null;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  /** Seconds the access token lives, as issued. */
  expires_in: number;
  /** Unix time (seconds) at which the access token expires. */
  expires_at: number;
  session_id?: string;
  /** The organization (slug) the token is issued for, if any. */
  org: string | null;
  org_role: string | null;
  user: User;
}

export interface AuthSettings {
  signup_enabled: boolean;
  email_verification_required: boolean;
  magic_link_enabled: boolean;
  mfa_enabled: boolean;
  providers: string[];
  password_policy: { kind: string; min_length: number };
}

export interface MfaStatus {
  enabled: boolean;
  aal: string | null;
  recovery_codes_remaining: number;
}

export interface MfaEnrollment {
  factor_id: string;
  /** The shared secret, for manual entry. */
  secret: string;
  /** An `otpauth://` URI to render as a QR code. */
  otpauth_uri: string;
}

export interface SessionInfo {
  id: string;
  method: string;
  aal: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string | null;
  last_refreshed_at: string | null;
  current: boolean;
}

export interface SignInEvent {
  kind: string;
  method: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  at: string;
}

export interface Organization {
  id: number;
  slug: string;
  name: string;
  metadata: Record<string, unknown>;
  /** The caller's role in it. */
  role: string | null;
  created_at: string | null;
}

export type OrgRole = "viewer" | "member" | "admin" | "owner";

export interface OrgMember {
  user_id: string;
  email: string;
  name: string;
  role: string;
}

export interface Invitation {
  id: number;
  email: string;
  role: string;
  expires_at: string;
}

export interface Team {
  slug: string;
  name: string;
  [key: string]: unknown;
}

/** One page of a list. */
export interface Page<T> {
  data: T[];
  /** The 1-based page number. */
  page: number;
  per_page: number;
  /**
   * How many records match for this caller. `null` when a per-row policy makes it unknowable
   * (and then pages can be short, or empty, with more behind them).
   */
  total: number | null;
}

export interface StorageBucket {
  name: string;
  public: boolean;
  accepts: string[];
  max_bytes: number;
}

export interface StoredObject {
  bucket: string;
  key: string;
  size: number;
  content_type: string;
  etag?: string;
}

export interface FileEntry {
  key: string;
  size: number;
  content_type: string;
  modified: string | number | null;
}

export interface FileListing {
  files: FileEntry[];
  /** "Folders": the distinct prefixes below the listed prefix. */
  prefixes: string[];
  /** Pass back to read the next page. Empty when this is the last. */
  cursor: string;
}

export interface SignedUrl {
  url: string;
  /** Unix time (seconds). */
  expires_at: number;
  method: "GET" | "PUT";
}

export interface ChannelMessage<T = unknown> {
  type: "message";
  id: string;
  channel: string;
  event: string;
  payload: T;
  /** The sender's user id; `"server"` for server-side publishes. */
  from: string | null;
  sent_at: string;
  /** Present on messages read from history. */
  seq?: number;
}

export interface PresenceMember<M = Record<string, unknown>> {
  presence_ref: string;
  user_id: string | null;
  meta: M;
  online_at: string;
}
