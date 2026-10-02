import { ConfigError } from "./errors.js";
import type { HttpClient } from "./http.js";
import type { FileEntry, FileListing, SignedUrl, StorageBucket, StoredObject } from "./types.js";
import { encodePath, isSecretKey } from "./util.js";

/** Anything an upload accepts. Streams upload without buffering but cannot be retried. */
export type UploadBody =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | string
  | ReadableStream<Uint8Array>
  | URLSearchParams
  | FormData;

export interface UploadOptions {
  /** The object's content type. Default: the `Blob`'s own type, else `application/octet-stream`. */
  contentType?: string;
  signal?: AbortSignal | null | undefined;
  timeoutMs?: number;
}

export interface TransferOptions {
  signal?: AbortSignal | null | undefined;
  timeoutMs?: number;
}

function cleanKey(key: string): string {
  const cleaned = key.replace(/^\/+/, "");
  if (!cleaned) throw new ConfigError("A storage key cannot be empty.");
  return cleaned;
}

/** Storage buckets declared in the project. */
export class StorageClient {
  constructor(private readonly http: HttpClient) {}

  /** The buckets this environment has. */
  async listBuckets(): Promise<StorageBucket[]> {
    return (await this.http.request<{ data: StorageBucket[] }>({ path: "/storage/v1/buckets" })).data;
  }

  /** Work with one bucket. */
  from(bucket: string): BucketClient {
    return new BucketClient(this.http, bucket);
  }
}

export class BucketClient {
  constructor(
    private readonly http: HttpClient,
    readonly name: string,
  ) {}

  private object(key: string): string {
    return `/storage/v1/object/${encodeURIComponent(this.name)}/${encodePath(cleanKey(key))}`;
  }

  /**
   * Upload (or overwrite) an object. The bucket's policy decides who may, and its
   * `accepts` and `max_bytes` limits apply: a refused type or size is an error, not a truncated file.
   */
  upload(key: string, body: UploadBody, options: UploadOptions = {}): Promise<StoredObject> {
    const declared =
      options.contentType ??
      (typeof Blob !== "undefined" && body instanceof Blob && body.type ? body.type : undefined) ??
      (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
    const multipart = typeof FormData !== "undefined" && body instanceof FormData;
    return this.http.request<StoredObject>({
      method: "PUT",
      path: this.object(key),
      body,
      ...(multipart ? {} : { headers: { "content-type": declared } }),
      signal: options.signal,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      // Replacing an object with itself is safe to repeat.
      idempotent: true,
    });
  }

  /** The object's bytes. */
  download(key: string, options: TransferOptions = {}): Promise<Blob> {
    return this.http.request<Blob>({ path: this.object(key), parse: "blob", headers: { accept: "*/*" }, ...this.opts(options) });
  }

  /** The object as text. */
  downloadText(key: string, options: TransferOptions = {}): Promise<string> {
    return this.http.request<string>({ path: this.object(key), parse: "text", headers: { accept: "*/*" }, ...this.opts(options) });
  }

  /** The object parsed as JSON. */
  async downloadJson<T = unknown>(key: string, options: TransferOptions = {}): Promise<T> {
    return JSON.parse(await this.downloadText(key, options)) as T;
  }

  /** The object as a stream, for large files. */
  async downloadStream(key: string, options: TransferOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const stream = await this.http.request<ReadableStream<Uint8Array> | null>({
      path: this.object(key),
      parse: "stream",
      headers: { accept: "*/*" },
      ...this.opts(options),
    });
    if (!stream) throw new ConfigError("The response had no body.");
    return stream;
  }

  /** The raw response, for its headers (`etag`, `content-type`, `content-length`). */
  downloadResponse(key: string, options: TransferOptions = {}): Promise<Response> {
    return this.http.request<Response>({ path: this.object(key), parse: "response", headers: { accept: "*/*" }, ...this.opts(options) });
  }

  /** Delete an object. A missing object (or one you may not see) is a `NotFoundError`. */
  async remove(key: string, options: TransferOptions = {}): Promise<void> {
    await this.http.request({ method: "DELETE", path: this.object(key), ...this.opts(options) });
  }

  /** One page of objects below a prefix. Pass the returned `cursor` back to continue. */
  list(options: { prefix?: string; cursor?: string; limit?: number } & TransferOptions = {}): Promise<FileListing> {
    return this.http.request<FileListing>({
      path: `/storage/v1/list/${encodeURIComponent(this.name)}`,
      query: { prefix: options.prefix, cursor: options.cursor, limit: options.limit },
      ...this.opts(options),
    });
  }

  /** Every object below a prefix, page by page. */
  async *listAll(options: { prefix?: string; pageSize?: number } & TransferOptions = {}): AsyncGenerator<FileEntry, void, void> {
    let cursor = "";
    do {
      const page = await this.list({
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(cursor ? { cursor } : {}),
        ...(options.pageSize !== undefined ? { limit: options.pageSize } : {}),
        signal: options.signal,
      });
      yield* page.files;
      cursor = page.cursor;
    } while (cursor);
  }

  /**
   * A URL for an object in a **public** bucket, usable in `<img src>`. The publishable key
   * travels in the URL (it is meant to be public); a secret key is refused.
   */
  getPublicUrl(key: string): string {
    const apiKey = this.http.config.apiKey;
    if (isSecretKey(apiKey)) {
      throw new ConfigError("Refusing to put a secret key in a URL. Use a publishable key, or createSignedUrl().");
    }
    return `${this.http.url(this.object(key))}?apikey=${encodeURIComponent(apiKey)}`;
  }

  /** A temporary URL that lets anyone with it read the object, with no key. Needs read access yourself. */
  createSignedUrl(key: string, options: { expiresIn?: number } & TransferOptions = {}): Promise<SignedUrl> {
    return this.sign(key, { method: "GET", expires_in: options.expiresIn ?? 300 }, options);
  }

  /**
   * A temporary URL that lets anyone with it upload one object, pinned to a content type
   * and size. Hand it to a browser or device; it then calls {@link uploadToSignedUrl}.
   */
  createSignedUploadUrl(
    key: string,
    options: { expiresIn?: number; contentType?: string; maxBytes?: number } & TransferOptions = {},
  ): Promise<SignedUrl> {
    return this.sign(
      key,
      {
        method: "PUT",
        expires_in: options.expiresIn ?? 300,
        ...(options.contentType ? { content_type: options.contentType } : {}),
        ...(options.maxBytes ? { max_bytes: options.maxBytes } : {}),
      },
      options,
    );
  }

  private sign(key: string, body: Record<string, unknown>, options: TransferOptions): Promise<SignedUrl> {
    return this.http.request<SignedUrl>({
      method: "POST",
      path: `/storage/v1/sign/${encodeURIComponent(this.name)}/${encodePath(cleanKey(key))}`,
      body,
      idempotent: true,
      ...this.opts(options),
    });
  }

  /** Upload through a signed upload URL. Sends no API key or token: the URL is the credential. */
  async uploadToSignedUrl(url: string, body: UploadBody, options: UploadOptions = {}): Promise<StoredObject> {
    const declared =
      options.contentType ??
      (typeof Blob !== "undefined" && body instanceof Blob && body.type ? body.type : "application/octet-stream");
    return this.http.request<StoredObject>({
      method: "PUT",
      path: "",
      absoluteUrl: url,
      body,
      headers: { "content-type": declared },
      signal: options.signal,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  private opts(options: TransferOptions): { signal: AbortSignal | null | undefined; timeoutMs?: number } {
    return { signal: options.signal, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) };
  }
}
