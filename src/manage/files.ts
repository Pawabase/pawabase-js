import { Definitions, Service, seg, type Api } from "./base.js";

/**
 * Storage administration: buckets, the objects in them, temporary share links and signed URLs. (Reading and writing files as
 * your app does is `client.storage`; this is the operator's view and works with a secret key regardless of policies.)
 */
export class Buckets extends Definitions {
  protected override readonly kind = "buckets";

  /** One page of the bucket's objects: `{ files, prefixes, cursor }`. */
  objects(bucket: string, options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<Api> {
    return this.get(seg(this.kind, bucket, "objects"), options);
  }

  /** One object's details and a way to read it. */
  object(bucket: string, key: string): Promise<Api> {
    return this.get(seg(this.kind, bucket, "object"), { key });
  }

  putObject(bucket: string, key: string, content: Blob | ArrayBuffer | Uint8Array | string, contentType = "application/octet-stream"): Promise<Api> {
    return this.http.request({
      method: "PUT",
      path: this.path(seg(this.kind, bucket, "object")),
      query: { key },
      body: content,
      headers: { "content-type": contentType },
    });
  }

  deleteObject(bucket: string, key: string): Promise<Api> {
    return this.del(seg(this.kind, bucket, "objects", key));
  }

  /** Rename or move an object inside the bucket. */
  moveObject(bucket: string, source: string, target: string): Promise<Api> {
    return this.post(seg(this.kind, bucket, "object", "move"), { source, target });
  }

  /** A temporary signed link to one object (`GET` to read, `PUT` to upload). */
  sign(bucket: string, key: string, options: { method?: "GET" | "PUT"; expiresIn?: number; contentType?: string; maxBytes?: number } = {}): Promise<Api> {
    return this.post(seg(this.kind, bucket, "sign"), {
      key,
      method: options.method ?? "GET",
      expires_in: options.expiresIn ?? 300,
      content_type: options.contentType,
      max_bytes: options.maxBytes,
    });
  }

  shares(bucket: string): Promise<Api> {
    return this.get(seg(this.kind, bucket, "shares"));
  }

  /** A link to one object for people with no account. `permissions`: `view`, `download`, `both`. The URL is in the answer. */
  createShare(bucket: string, key: string, options: { expiresIn?: number; permissions?: "view" | "download" | "both"; label?: string } = {}): Promise<Api> {
    return this.post(seg(this.kind, bucket, "shares"), {
      key,
      expires_in: options.expiresIn ?? 3600,
      permissions: options.permissions ?? "both",
      label: options.label ?? "",
    });
  }

  revokeShare(bucket: string, shareId: string): Promise<Api> {
    return this.del(seg(this.kind, bucket, "shares", shareId));
  }
}

/** The environment's response cache. */
export class Cache extends Service {
  stats(): Promise<Api> {
    return this.get("/cache");
  }

  /** Drop cached responses by tag (`resource:posts`) or for whole resources. */
  invalidate(options: { tags?: string[]; resources?: string[] } = {}): Promise<Api> {
    return this.post("/cache/invalidate", { tags: options.tags ?? [], resources: options.resources ?? [] });
  }
}
