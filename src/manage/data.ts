import { Definitions, Service, seg, type Api, type Body, type Query } from "./base.js";

/**
 * Resources: the tables your API serves, with fields, relations, per-operation policies and indexes.
 *
 * ```ts
 * await m.resources.create({ name: "posts", fields: [{ name: "title", type: "string", required: true }],
 *                            operations: { list: { enabled: true, policy: "public" } } });
 * await m.resources.migrate("posts");
 * ```
 */
export class Resources extends Definitions {
  protected override readonly kind = "resources";

  /** Browse a resource's records as an operator (policies do not apply). Extra keys are passed as query parameters (`filter[field]`…). */
  records(name: string, options: { limit?: number; offset?: number; filters?: Query } = {}): Promise<Api> {
    return this.get(seg(this.kind, name, "records"), { limit: options.limit, offset: options.offset, ...options.filters });
  }

  insert(name: string, values: Body): Promise<Api> {
    return this.post(seg(this.kind, name, "records"), values);
  }

  updateRecord(name: string, recordId: string | number, values: Body): Promise<Api> {
    return this.patch(seg(this.kind, name, "records", recordId), values);
  }

  deleteRecord(name: string, recordId: string | number): Promise<Api> {
    return this.del(seg(this.kind, name, "records", recordId));
  }

  /** Every record, for a file download. */
  export(name: string, options: { format?: string } = {}): Promise<Api> {
    return this.get(seg(this.kind, name, "export"), { format: options.format });
  }

  /** Add or update records from parsed rows: `{ created, updated, failed, errors }`. */
  importRecords(name: string, rows: Body[], options: { key?: string; mode?: string; dryRun?: boolean } = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "import"), { rows, key: options.key, mode: options.mode, dry_run: options.dryRun });
  }

  /** The resource's compiled routes. */
  openapi(name: string): Promise<Api> {
    return this.get(seg(this.kind, name, "openapi"));
  }

  /** Create the resource's table, or add what its definition gained. Returns the statements it ran. */
  migrate(name: string): Promise<Api> {
    return this.post(seg(this.kind, name, "migrate"));
  }

  /** What applying the definition would change. */
  schemaPlan(name: string): Promise<Api> {
    return this.get(seg(this.kind, name, "schema"));
  }

  schemaApply(name: string, body: Body = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "schema", "apply"), body);
  }

  /** Take the table as it is now as the starting point and put what changed in the definition. */
  schemaAcknowledge(name: string, body: Body = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "schema", "acknowledge"), body);
  }

  /** Remove what migrations kept for a rollback. */
  schemaPurge(name: string, body: Body = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "schema", "purge"), body);
  }

  migrations(name: string): Promise<Api> {
    return this.get(seg(this.kind, name, "migrations"));
  }

  rollbackMigration(name: string, migrationId: string): Promise<Api> {
    return this.post(seg(this.kind, name, "migrations", migrationId, "rollback"));
  }

  /** A table's indexes: declared, field, hand-made and system. */
  indexes(name: string): Promise<Api> {
    return this.get(seg(this.kind, name, "indexes"));
  }

  /** Drop an index made outside Pawabase. */
  dropIndex(name: string, index: string, body: Body = {}): Promise<Api> {
    return this.post(seg(this.kind, name, "indexes", index, "drop"), body);
  }
}

/** The whole database against its definitions. */
export class Schema extends Service {
  /** Every resource's table against its definition. */
  overview(): Promise<Api> {
    return this.get("/schema");
  }

  /** Tables in the database that no resource is defined for. */
  unmappedTables(): Promise<Api> {
    return this.get("/schema/tables");
  }
}

/** Named access policies (conditions) that resources, buckets, channels and functions refer to. */
export class Policies extends Definitions {
  protected override readonly kind = "policies";
}

/** Reusable data shapes referred to by resource fields. */
export class Schemas extends Definitions {
  protected override readonly kind = "schemas";
}

/** Transformers that reshape a field's value on the way out (hide, mask, format). */
export class Transformers extends Definitions {
  protected override readonly kind = "transformers";
}

/** Custom HTTP routes under `/rest` that run a flow. */
export class Routes extends Definitions {
  protected override readonly kind = "routes";
}

/** The environment's database: tables, rows and the SQL console (one statement at a time; reads are read-only in the database itself). */
export class Database extends Service {
  info(): Promise<Api> {
    return this.get("/database");
  }

  /** A table's columns, indexes and foreign keys. */
  table(table: string): Promise<Api> {
    return this.get(seg("database", "tables", table));
  }

  rows(table: string, options: { limit?: number; offset?: number; sort?: string; filters?: Query } = {}): Promise<Api> {
    return this.get(seg("database", "tables", table, "rows"), { limit: options.limit, offset: options.offset, sort: options.sort, ...options.filters });
  }

  /** Run one statement. A write needs `allowWrite`; it is audited and clears the environment's caches. */
  query(sql: string, params: unknown[] = [], options: { allowWrite?: boolean } = {}): Promise<Api> {
    return this.post("/database/query", { sql, params, allow_write: options.allowWrite ?? false });
  }
}

/** The runtime capabilities a function sees, called remotely (what `pawabase emulate` uses). */
export class Runtime extends Service {
  call(method: string, args: unknown[] = [], kwargs: Body = {}, options: { asUser?: Body; branch?: string } = {}): Promise<Api> {
    return this.post("/runtime/call", { method, args, kwargs, as_user: options.asUser ?? null, branch: options.branch ?? null });
  }

  /** `fetch`, `insert`, `execute`, `begin`, `commit`…, optionally inside a transaction (`tx`). */
  sql(op: string, fields: Body = {}): Promise<Api> {
    return this.post("/runtime/db", { op, ...fields });
  }

  /** Who a user access token belongs to. */
  identify(token: string | null): Promise<Api> {
    return this.post("/runtime/identify", { token });
  }
}
