/**
 * Turn a project's OpenAPI document into TypeScript types for `createClient<Database>()`.
 *
 * The compiled API documents each resource as a read model, a create body and an update
 * body. The create body says which fields are required; the read model marks every field
 * nullable (a `select` can leave columns out as `null`), so the generator uses the create
 * body to tell "always present" from "may be null".
 */

type Schema = Record<string, any>;

export interface TypegenOptions {
  /** The name of the exported root interface. Default `Database`. */
  name?: string;
  /** Text for the header comment, e.g. where the spec came from. */
  source?: string;
}

const RESERVED_SYSTEM = new Set(["created_at", "updated_at"]);

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function resolve(spec: Schema, node: Schema | undefined): Schema | undefined {
  let current = node;
  for (let depth = 0; current && typeof current["$ref"] === "string" && depth < 10; depth++) {
    const path = (current["$ref"] as string).replace(/^#\//, "").split("/");
    let target: any = spec;
    for (const part of path) target = target?.[part];
    current = target;
  }
  return current;
}

/** A schema as a TypeScript type expression. */
function typeOf(spec: Schema, node: Schema | undefined): string {
  const schema = resolve(spec, node);
  if (!schema || Object.keys(schema).length === 0) return "unknown";
  const variants = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(variants)) {
    const parts = variants.map((variant: Schema) => typeOf(spec, variant));
    const unique = [...new Set(parts)];
    return unique.includes("unknown") ? "unknown" : unique.join(" | ");
  }
  if (Array.isArray(schema["enum"])) return schema["enum"].map((value: unknown) => JSON.stringify(value)).join(" | ");
  switch (schema["type"]) {
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const inner = typeOf(spec, schema["items"]);
      return inner.includes(" | ") ? `Array<${inner}>` : `${inner}[]`;
    }
    case "object":
      return schema["properties"] ? "Record<string, unknown>" : "Record<string, unknown>";
    default:
      return "unknown";
  }
}

/** The schema without its `null` variant, and whether it had one. */
function stripNull(spec: Schema, node: Schema | undefined): { type: string; nullable: boolean } {
  const type = typeOf(spec, node);
  const parts = type.split(" | ");
  const nullable = parts.includes("null");
  const rest = parts.filter((part) => part !== "null");
  return { type: rest.length ? rest.join(" | ") : "unknown", nullable };
}

function bodySchema(spec: Schema, operation: Schema | undefined): Schema | undefined {
  return resolve(spec, operation?.["requestBody"]?.["content"]?.["application/json"]?.["schema"]);
}

function listRow(spec: Schema, operation: Schema | undefined): Schema | undefined {
  const page = resolve(spec, operation?.["responses"]?.["200"]?.["content"]?.["application/json"]?.["schema"]);
  return resolve(spec, page?.["properties"]?.["data"]?.["items"]);
}

interface Resource {
  name: string;
  row: Schema;
  insert: Schema | undefined;
  update: Schema | undefined;
}

export function findResources(spec: Schema): Resource[] {
  const found: Resource[] = [];
  for (const [path, item] of Object.entries<Schema>(spec["paths"] ?? {})) {
    const match = /^\/rest\/v\d+\/([^/{}]+)$/.exec(path);
    if (!match) continue;
    const row = listRow(spec, item["get"]) ?? resolve(spec, item["post"]?.["responses"]?.["201"]?.["content"]?.["application/json"]?.["schema"]);
    if (!row?.["properties"]) continue; // a custom route, not a resource
    const withId = spec["paths"][`${path}/{id}`] as Schema | undefined;
    found.push({
      name: match[1]!,
      row,
      insert: bodySchema(spec, item["post"]),
      update: bodySchema(spec, withId?.["patch"]),
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function describe(spec: Schema, resource: Resource): string {
  const type = pascal(resource.name);
  const required = new Set<string>(resource.insert?.["required"] ?? []);
  const insertProps: Schema = resource.insert?.["properties"] ?? {};
  const rowProps: Schema = resource.row["properties"] ?? {};
  const lines: string[] = [];

  // Row: what a read returns.
  const row: string[] = [];
  const primary = rowProps["id"];
  if (primary) {
    const id = stripNull(spec, primary).type;
    row.push(`  id: ${id};`);
  }
  for (const [name, node] of Object.entries<Schema>(rowProps)) {
    if (name === "id") continue;
    const { type } = stripNull(spec, node);
    const guaranteed = required.has(name) || (insertProps[name] && "default" in insertProps[name] && insertProps[name]["default"] !== null);
    row.push(`  ${key(name)}: ${type === "unknown" ? "unknown" : guaranteed ? type : `${type} | null`};`);
  }
  for (const system of RESERVED_SYSTEM) {
    if (!(system in rowProps)) row.push(`  ${system}?: string;`);
  }
  lines.push(`export interface ${type}Row {`, ...row, "}", "");

  // Insert: what a create accepts.
  const insert: string[] = [];
  for (const [name, node] of Object.entries<Schema>(insertProps)) {
    const { type, nullable } = stripNull(spec, node);
    insert.push(`  ${key(name)}${required.has(name) ? "" : "?"}: ${type}${nullable && type !== "unknown" ? " | null" : ""};`);
  }
  lines.push(`export interface ${type}Insert {`, ...insert, "}", "");

  // Update: a PATCH takes any field, null included.
  const updateProps: Schema = resource.update?.["properties"] ?? insertProps;
  const update: string[] = [];
  for (const [name, node] of Object.entries<Schema>(updateProps)) {
    const { type } = stripNull(spec, node);
    update.push(`  ${key(name)}?: ${type === "unknown" ? "unknown" : `${type} | null`};`);
  }
  lines.push(`export interface ${type}Update {`, ...update, "}", "");
  return lines.join("\n");
}

/** The generated file's text. */
export function generateTypes(spec: Schema, options: TypegenOptions = {}): string {
  const root = options.name ?? "Database";
  const resources = findResources(spec);
  const title: string = spec["info"]?.["title"] ?? "Pawabase API";
  const version: string = spec["info"]?.["version"] ?? "";
  const out: string[] = [
    "/* eslint-disable */",
    `// Generated by pawabase-types from "${title}" ${version}${options.source ? ` (${options.source})` : ""}.`,
    "// Do not edit by hand: regenerate when your resources change.",
    "",
  ];
  for (const resource of resources) out.push(describe(spec, resource));
  out.push(`export interface ${root} {`, "  resources: {");
  for (const resource of resources) {
    const type = pascal(resource.name);
    out.push(`    ${key(resource.name)}: { Row: ${type}Row; Insert: ${type}Insert; Update: ${type}Update };`);
  }
  out.push("  };", "}", "");
  out.push(
    `/** A resource's row: \`Row<"posts">\`. */`,
    `export type Row<K extends keyof ${root}["resources"]> = ${root}["resources"][K]["Row"];`,
    `/** What a create accepts: \`Insert<"posts">\`. */`,
    `export type Insert<K extends keyof ${root}["resources"]> = ${root}["resources"][K]["Insert"];`,
    `/** What an update accepts: \`Update<"posts">\`. */`,
    `export type Update<K extends keyof ${root}["resources"]> = ${root}["resources"][K]["Update"];`,
    "",
  );
  return out.join("\n");
}
