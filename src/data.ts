import { InvalidQueryError, NotFoundError } from "./errors.js";
import type { HttpClient } from "./http.js";
import type { Page } from "./types.js";
import { encodePath } from "./util.js";

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "nin" | "is" | "isnot";

type Scalar = string | number | bigint | boolean | Date | null;

/** The default row type for an untyped resource. */
export type AnyRow = Record<string, unknown>;

/** What a typed `Database` declares for one resource. */
export interface ResourceTypes<Row = AnyRow, Insert = Partial<Row>, Update = Partial<Row>> {
  Row: Row;
  Insert: Insert;
  Update: Update;
}

/** Condition objects for {@link QueryBuilder.where}: `{ status: "live", views: { gte: 10 } }`. */
export type Condition =
  | Scalar
  | { eq?: Scalar; neq?: Scalar; gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar; like?: string; ilike?: string; in?: Scalar[]; nin?: Scalar[]; is?: null | boolean; isnot?: null | boolean };

export interface QueryOptions {
  signal?: AbortSignal | null | undefined;
  /** Pass through to the transport: a per-call timeout or retry policy. */
  timeoutMs?: number;
}

export interface IterateOptions extends QueryOptions {
  /** Rows per request. Default `100`; the server's maximum is 200. */
  pageSize?: number;
  /** Stop after this many rows. */
  maxRecords?: number;
  /**
   * When the server cannot count (`total: null`, a per-row policy) a short or empty page
   * does not mean the end. Stop after this many empty pages in a row. Default `1`.
   */
  stopAfterEmptyPages?: number;
}

interface State {
  filters: Map<string, string>;
  sort: string[];
  select: string[] | null;
  expand: string[];
  page: number;
  perPage: number | null;
  /** An `in ()` with no values matches nothing: answered locally. */
  empty: boolean;
}

function format(value: Scalar, op: FilterOp, column: string): string {
  if (value === null) throw new InvalidQueryError(`Filter on ${column}: null needs is()/isNot(), not ${op}.`);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return value;
}

function encode(
  column: string,
  op: FilterOp,
  value: unknown,
): { op: string; value: string } | { empty: true } | { skip: true } {
  switch (op) {
    case "eq":
    case "neq": {
      // `filter[flag]=eq.false` matches true rows on the server; booleans and null go through is/isnot.
      if (value === null) return { op: op === "eq" ? "is" : "isnot", value: "null" };
      if (typeof value === "boolean") return { op: op === "eq" ? "is" : "isnot", value: String(value) };
      return { op, value: format(value as Scalar, op, column) };
    }
    case "is":
    case "isnot": {
      if (value !== null && typeof value !== "boolean") {
        throw new InvalidQueryError(`Filter on ${column}: ${op} takes null, true or false.`);
      }
      return { op, value: String(value) };
    }
    case "in":
    case "nin": {
      if (!Array.isArray(value)) throw new InvalidQueryError(`Filter on ${column}: ${op} takes an array.`);
      if (value.length === 0) return op === "in" ? { empty: true } : { skip: true };
      const parts = value.map((item) => format(item as Scalar, op, column));
      const bad = parts.find((part) => part.includes(","));
      if (bad !== undefined) {
        throw new InvalidQueryError(
          `Filter on ${column}: the value ${JSON.stringify(bad)} contains a comma, and the server splits ${op} lists on commas.`,
        );
      }
      return { op, value: parts.join(",") };
    }
    case "like":
    case "ilike":
      if (typeof value !== "string") throw new InvalidQueryError(`Filter on ${column}: ${op} takes a string pattern.`);
      return { op, value };
    default:
      return { op, value: format(value as Scalar, op, column) };
  }
}

/**
 * A query on one resource. Builders are immutable: every method returns a new one, so
 * a base query can be reused. It is also a promise, so `await` runs it.
 *
 * ```ts
 * const page = await client.from("posts").eq("status", "live").order("created_at", "desc").perPage(20);
 * for await (const post of client.from("posts").eq("status", "live")) { … }
 * ```
 */
export class QueryBuilder<Row = AnyRow> implements PromiseLike<Page<Row>> {
  constructor(
    private readonly http: HttpClient,
    private readonly resource: string,
    private readonly state: State = {
      filters: new Map(),
      sort: [],
      select: null,
      expand: [],
      page: 1,
      perPage: null,
      empty: false,
    },
    private readonly options: QueryOptions = {},
  ) {}

  private with(patch: Partial<State>, options?: QueryOptions): QueryBuilder<Row> {
    return new QueryBuilder<Row>(
      this.http,
      this.resource,
      { ...this.state, filters: new Map(this.state.filters), ...patch },
      { ...this.options, ...options },
    );
  }

  // ── filters ───────────────────────────────────────────────────────────

  /**
   * Add a filter. The server accepts one filter per field and keeps only the last when
   * a field repeats, so a second filter on the same field throws instead of silently
   * dropping one. For a two-sided range, see the docs (a stored period field, or a route).
   */
  filter(column: string, op: FilterOp, value: unknown): QueryBuilder<Row> {
    if (this.state.filters.has(column)) {
      throw new InvalidQueryError(
        `There is already a filter on "${column}". The server applies one filter per field and drops the others, so a range with two bounds on one field cannot be written as a single list request.`,
      );
    }
    const encoded = encode(column, op, value);
    const filters = new Map(this.state.filters);
    if ("empty" in encoded) return this.with({ empty: true, filters });
    if ("skip" in encoded) return this.with({ filters });
    filters.set(column, `${encoded.op}.${encoded.value}`);
    return this.with({ filters });
  }

  eq<K extends keyof Row & string>(column: K, value: Row[K] | null): QueryBuilder<Row> {
    return this.filter(column, "eq", value);
  }
  neq<K extends keyof Row & string>(column: K, value: Row[K] | null): QueryBuilder<Row> {
    return this.filter(column, "neq", value);
  }
  gt<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.filter(column, "gt", value);
  }
  gte<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.filter(column, "gte", value);
  }
  lt<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.filter(column, "lt", value);
  }
  lte<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.filter(column, "lte", value);
  }
  /** Pattern match. `*` and `%` match any run of characters. Whether it ignores case depends on the database. */
  like<K extends keyof Row & string>(column: K, pattern: string): QueryBuilder<Row> {
    return this.filter(column, "like", pattern);
  }
  /** Case-insensitive match on PostgreSQL; on other databases the same as {@link like}. */
  ilike<K extends keyof Row & string>(column: K, pattern: string): QueryBuilder<Row> {
    return this.filter(column, "ilike", pattern);
  }
  /** Matches any of the values. Values cannot contain commas. An empty list matches nothing. */
  in<K extends keyof Row & string>(column: K, values: ReadonlyArray<Row[K]>): QueryBuilder<Row> {
    return this.filter(column, "in", values);
  }
  notIn<K extends keyof Row & string>(column: K, values: ReadonlyArray<Row[K]>): QueryBuilder<Row> {
    return this.filter(column, "nin", values);
  }
  /** `null`, `true` or `false`. The right way to test booleans. */
  is<K extends keyof Row & string>(column: K, value: null | boolean): QueryBuilder<Row> {
    return this.filter(column, "is", value);
  }
  isNot<K extends keyof Row & string>(column: K, value: null | boolean): QueryBuilder<Row> {
    return this.filter(column, "isnot", value);
  }

  /** Several filters at once: `{ status: "live", views: { gte: 10 } }`. */
  where(conditions: { [K in keyof Row & string]?: Condition }): QueryBuilder<Row> {
    let query: QueryBuilder<Row> = this;
    for (const [column, condition] of Object.entries(conditions)) {
      if (condition === undefined) continue;
      if (typeof condition === "object" && condition !== null && !(condition instanceof Date)) {
        const entries = Object.entries(condition) as Array<[FilterOp, unknown]>;
        if (entries.length !== 1) {
          throw new InvalidQueryError(
            `where(): "${column}" has ${entries.length} operators; the server takes one filter per field.`,
          );
        }
        const [op, value] = entries[0] as [FilterOp, unknown];
        query = query.filter(column, op, value);
      } else {
        query = query.filter(column, "eq", condition);
      }
    }
    return query;
  }

  // ── shape ─────────────────────────────────────────────────────────────

  /** Order by a column. Call again for tie-breakers. The default order is the primary key. */
  order<K extends keyof Row & string>(column: K, direction: "asc" | "desc" = "asc"): QueryBuilder<Row> {
    return this.with({ sort: [...this.state.sort, `${direction === "desc" ? "-" : ""}${column}`] });
  }

  /**
   * Ask for only these columns (the primary key is always included). Columns you leave out
   * still appear in each row, but as `null`, so the result type keeps them optional.
   */
  select<K extends keyof Row & string>(...columns: K[]): QueryBuilder<Pick<Row, K> & Partial<Row>> {
    return this.with({ select: columns }) as unknown as QueryBuilder<Pick<Row, K> & Partial<Row>>;
  }

  /** Embed `belongs_to` / `has_many` relations declared on the resource. */
  expand(...relations: string[]): QueryBuilder<Row> {
    return this.with({ expand: [...this.state.expand, ...relations] });
  }

  /** The 1-based page. */
  page(page: number): QueryBuilder<Row> {
    return this.with({ page });
  }

  /** Rows per page. The server allows 1 to 200 (20 by default). */
  perPage(perPage: number): QueryBuilder<Row> {
    return this.with({ perPage });
  }

  /** Alias of {@link perPage}. */
  limit(count: number): QueryBuilder<Row> {
    return this.perPage(count);
  }

  /** Abort or time-limit this query. */
  withOptions(options: QueryOptions): QueryBuilder<Row> {
    return this.with({}, options);
  }

  // ── running ───────────────────────────────────────────────────────────

  private params(): Record<string, string | number | undefined> {
    const params: Record<string, string | number | undefined> = {};
    for (const [column, value] of this.state.filters) params[`filter[${column}]`] = value;
    if (this.state.sort.length) params["sort"] = this.state.sort.join(",");
    if (this.state.select) params["select"] = this.state.select.join(",");
    if (this.state.expand.length) params["expand"] = [...new Set(this.state.expand)].join(",");
    if (this.state.page !== 1) params["page"] = this.state.page;
    if (this.state.perPage !== null) params["per_page"] = this.state.perPage;
    return params;
  }

  /** Run the query and return one page. `await`ing the builder does the same. */
  async execute(): Promise<Page<Row>> {
    if (this.state.empty) {
      return { data: [], page: this.state.page, per_page: this.state.perPage ?? 20, total: 0 };
    }
    return this.http.request<Page<Row>>({
      path: `/rest/v1/${encodePath(this.resource)}`,
      query: this.params() as Record<string, string | number>,
      signal: this.options.signal,
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
    });
  }

  then<R1 = Page<Row>, R2 = never>(
    onfulfilled?: ((value: Page<Row>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  /** The first matching row, or `null`. */
  async first(): Promise<Row | null> {
    const page = await this.perPage(1).page(1).execute();
    return page.data[0] ?? null;
  }

  /** The first matching row; throws {@link NotFoundError} when there is none. */
  async single(): Promise<Row> {
    const row = await this.first();
    if (row === null) {
      throw new NotFoundError({ status: 404, code: "not_found", message: `No ${this.resource} record matches.` });
    }
    return row;
  }

  /**
   * How many rows match. Throws when the server cannot count (a per-row policy
   * makes `total` unknowable); use {@link all} and count instead.
   */
  async count(): Promise<number> {
    const page = await this.perPage(1).page(1).execute();
    if (page.total === null) {
      throw new InvalidQueryError(
        `The server cannot count ${this.resource} for this caller: a per-row policy makes the total unknown. Fetch the rows with all() and count them.`,
      );
    }
    return page.total;
  }

  /** Whether any row matches. */
  async exists(): Promise<boolean> {
    return (await this.first()) !== null;
  }

  /** Walk the result one page at a time, from the current page on. */
  async *pages(options: IterateOptions = {}): AsyncGenerator<Page<Row>, void, void> {
    const pageSize = options.pageSize ?? this.state.perPage ?? 100;
    const stopAfterEmpty = Math.max(1, options.stopAfterEmptyPages ?? 1);
    let query = this.perPage(pageSize).withOptions({
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    let seen = 0;
    let empties = 0;
    for (;;) {
      const page = await query.execute();
      yield page;
      seen += page.data.length;
      if (options.maxRecords !== undefined && seen >= options.maxRecords) return;
      if (page.total !== null) {
        if (page.page * page.per_page >= page.total) return;
      } else {
        // Unknown total: a per-row policy filters after the page is read, so a short page proves nothing.
        empties = page.data.length === 0 ? empties + 1 : 0;
        if (empties >= stopAfterEmpty) return;
      }
      query = query.page(page.page + 1);
    }
  }

  /** Every matching row, across pages. Mind the cost on large tables; `maxRecords` caps it. */
  async all(options: IterateOptions = {}): Promise<Row[]> {
    const rows: Row[] = [];
    for await (const page of this.pages(options)) {
      rows.push(...page.data);
      if (options.maxRecords !== undefined && rows.length >= options.maxRecords) break;
    }
    return options.maxRecords !== undefined ? rows.slice(0, options.maxRecords) : rows;
  }

  /** Iterate rows lazily: `for await (const row of query)`. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Row, void, void> {
    for await (const page of this.pages()) yield* page.data;
  }
}

export interface ReadOptions extends QueryOptions {
  expand?: string[];
}

export interface CreateManyResult<Row> {
  created: Row[];
  failed: Array<{ index: number; error: unknown }>;
}

/** Create, read, update and delete records of one resource. */
export class ResourceClient<
  Row = AnyRow,
  Insert = Partial<Row>,
  Update = Partial<Row>,
> {
  constructor(
    private readonly http: HttpClient,
    readonly name: string,
  ) {}

  private path(id?: string | number): string {
    const base = `/rest/v1/${encodePath(this.name)}`;
    return id === undefined ? base : `${base}/${encodeURIComponent(String(id))}`;
  }

  /** Start a query. Every filter and shape method below is a shortcut for `query().…`. */
  query(): QueryBuilder<Row> {
    return new QueryBuilder<Row>(this.http, this.name);
  }

  /** One page of records, using plain parameters. For anything richer, build a query. */
  list(params: {
    where?: { [K in keyof Row & string]?: Condition };
    sort?: string | string[];
    select?: Array<keyof Row & string>;
    expand?: string[];
    page?: number;
    perPage?: number;
    signal?: AbortSignal | null;
  } = {}): Promise<Page<Row>> {
    let query = this.query();
    if (params.where) query = query.where(params.where);
    const specs = typeof params.sort === "string" ? params.sort.split(",") : (params.sort ?? []);
    for (const spec of specs.map((s) => s.trim()).filter(Boolean)) {
      query = spec.startsWith("-") ? query.order(spec.slice(1) as keyof Row & string, "desc") : query.order(spec.replace(/^\+/, "") as keyof Row & string);
    }
    if (params.select) query = query.select(...params.select) as unknown as QueryBuilder<Row>;
    if (params.expand) query = query.expand(...params.expand);
    if (params.page) query = query.page(params.page);
    if (params.perPage) query = query.perPage(params.perPage);
    if (params.signal) query = query.withOptions({ signal: params.signal });
    return query.execute();
  }

  where(conditions: { [K in keyof Row & string]?: Condition }): QueryBuilder<Row> {
    return this.query().where(conditions);
  }
  filter(column: string, op: FilterOp, value: unknown): QueryBuilder<Row> {
    return this.query().filter(column, op, value);
  }
  eq<K extends keyof Row & string>(column: K, value: Row[K] | null): QueryBuilder<Row> {
    return this.query().eq(column, value);
  }
  neq<K extends keyof Row & string>(column: K, value: Row[K] | null): QueryBuilder<Row> {
    return this.query().neq(column, value);
  }
  gt<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.query().gt(column, value);
  }
  gte<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.query().gte(column, value);
  }
  lt<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.query().lt(column, value);
  }
  lte<K extends keyof Row & string>(column: K, value: Row[K] | Date): QueryBuilder<Row> {
    return this.query().lte(column, value);
  }
  like<K extends keyof Row & string>(column: K, pattern: string): QueryBuilder<Row> {
    return this.query().like(column, pattern);
  }
  ilike<K extends keyof Row & string>(column: K, pattern: string): QueryBuilder<Row> {
    return this.query().ilike(column, pattern);
  }
  in<K extends keyof Row & string>(column: K, values: ReadonlyArray<Row[K]>): QueryBuilder<Row> {
    return this.query().in(column, values);
  }
  notIn<K extends keyof Row & string>(column: K, values: ReadonlyArray<Row[K]>): QueryBuilder<Row> {
    return this.query().notIn(column, values);
  }
  is<K extends keyof Row & string>(column: K, value: null | boolean): QueryBuilder<Row> {
    return this.query().is(column, value);
  }
  isNot<K extends keyof Row & string>(column: K, value: null | boolean): QueryBuilder<Row> {
    return this.query().isNot(column, value);
  }
  order<K extends keyof Row & string>(column: K, direction: "asc" | "desc" = "asc"): QueryBuilder<Row> {
    return this.query().order(column, direction);
  }
  select<K extends keyof Row & string>(...columns: K[]): QueryBuilder<Pick<Row, K> & Partial<Row>> {
    return this.query().select(...columns);
  }
  expand(...relations: string[]): QueryBuilder<Row> {
    return this.query().expand(...relations);
  }
  page(page: number): QueryBuilder<Row> {
    return this.query().page(page);
  }
  perPage(count: number): QueryBuilder<Row> {
    return this.query().perPage(count);
  }
  limit(count: number): QueryBuilder<Row> {
    return this.query().perPage(count);
  }

  /** The first record in the default order, or `null`. */
  first(): Promise<Row | null> {
    return this.query().first();
  }
  /** How many records the caller can see. See {@link QueryBuilder.count}. */
  count(): Promise<number> {
    return this.query().count();
  }
  /** Every record, across pages. See {@link QueryBuilder.all}. */
  all(options: IterateOptions = {}): Promise<Row[]> {
    return this.query().all(options);
  }
  /** Walk every record page by page. */
  pages(options: IterateOptions = {}): AsyncGenerator<Page<Row>, void, void> {
    return this.query().pages(options);
  }
  /** Iterate every record lazily: `for await (const row of client.from("posts"))`. */
  [Symbol.asyncIterator](): AsyncGenerator<Row, void, void> {
    return this.query()[Symbol.asyncIterator]();
  }

  /** One record. `404` also means "a read policy hides it": see {@link maybeGet}. */
  get(id: string | number, options: ReadOptions = {}): Promise<Row> {
    return this.http.request<Row>({
      path: this.path(id),
      ...(options.expand?.length ? { query: { expand: options.expand.join(",") } } : {}),
      signal: options.signal,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /** Like {@link get}, but `null` when there is no such record (or a policy hides it). */
  async maybeGet(id: string | number, options: ReadOptions = {}): Promise<Row | null> {
    try {
      return await this.get(id, options);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** Create a record; returns it with its server-assigned fields (`id`, timestamps, defaults). */
  create(row: Insert, options: QueryOptions = {}): Promise<Row> {
    return this.http.request<Row>({ method: "POST", path: this.path(), body: row, signal: options.signal });
  }

  /**
   * Create several records, a few at a time. This is **not atomic**: some can succeed while
   * others fail, so the result lists both. With `stopOnError`, no new request starts after
   * the first failure.
   */
  async createMany(
    rows: Insert[],
    options: QueryOptions & { concurrency?: number; stopOnError?: boolean } = {},
  ): Promise<CreateManyResult<Row>> {
    const result: CreateManyResult<Row> = { created: [], failed: [] };
    const slots: Row[] = new Array(rows.length);
    let next = 0;
    let stop = false;
    const worker = async () => {
      while (!stop) {
        const index = next++;
        if (index >= rows.length) return;
        try {
          slots[index] = await this.create(rows[index] as Insert, options);
        } catch (error) {
          result.failed.push({ index, error });
          if (options.stopOnError) stop = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 5, rows.length)) }, worker));
    result.created = slots.filter((row) => row !== undefined);
    result.failed.sort((a, b) => a.index - b.index);
    return result;
  }

  /** Change the listed fields. (A `PATCH` accepts `null` for any field, even a required one.) */
  update(id: string | number, patch: Update, options: QueryOptions = {}): Promise<Row> {
    return this.http.request<Row>({ method: "PATCH", path: this.path(id), body: patch, signal: options.signal });
  }

  /** Replace the record (`PUT`). */
  replace(id: string | number, row: Insert, options: QueryOptions = {}): Promise<Row> {
    return this.http.request<Row>({ method: "PUT", path: this.path(id), body: row, signal: options.signal });
  }

  /** Delete a record. */
  async delete(id: string | number, options: QueryOptions = {}): Promise<void> {
    await this.http.request({ method: "DELETE", path: this.path(id), signal: options.signal });
  }
}
