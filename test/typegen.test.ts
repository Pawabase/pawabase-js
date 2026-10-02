import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createClient, generateTypes } from "../src/index.js";
import type { Database } from "./fixtures/pawabase.types.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

const fixture = (name: string) => new URL(`../../test/fixtures/${name}`, import.meta.url);

test("the generator reproduces the committed types from the OpenAPI fixture", () => {
  const spec = JSON.parse(readFileSync(fixture("openapi.json"), "utf8"));
  const body = (text: string) => text.split("\n").slice(3).join("\n");
  const committed = readFileSync(fixture("pawabase.types.ts"), "utf8");
  assert.equal(body(generateTypes(spec)), body(committed));
});

test("required fields are non-null, optional ones nullable, and every resource appears", () => {
  const spec = JSON.parse(readFileSync(fixture("openapi.json"), "utf8"));
  const text = generateTypes(spec);
  assert.match(text, /export interface PostsRow \{[^}]*title: string;/s);
  assert.match(text, /org_id: string \| null;/);
  assert.match(text, /export interface PostsInsert \{\s*title: string;/s);
  assert.match(text, /posts: \{ Row: PostsRow; Insert: PostsInsert; Update: PostsUpdate \};/);
  assert.match(text, /tasks: \{ Row: TasksRow/);
});

test("enums, arrays and odd names become valid types", () => {
  const spec = {
    info: { title: "T", version: "1" },
    paths: {
      "/rest/v1/line_items": {
        get: { responses: { "200": { content: { "application/json": { schema: { properties: { data: { items: { $ref: "#/components/schemas/LineItems" } } } } } } } } },
        post: { requestBody: { content: { "application/json": { schema: { required: ["kind"], properties: { kind: { enum: ["a", "b"], type: "string" }, tags: { type: "array", items: { type: "string" } }, "odd-key": { type: "integer" } } } } } } },
      },
      "/rest/v1/checkout": { post: { responses: {} } },
    },
    components: { schemas: { LineItems: { properties: { id: { type: "string" }, kind: { enum: ["a", "b"], type: "string" }, tags: { type: "array", items: { type: "string" } }, "odd-key": { type: "integer" } } } } },
  };
  const text = generateTypes(spec);
  assert.match(text, /kind: "a" \| "b";/);
  assert.match(text, /tags: string\[\] \| null;/);
  assert.match(text, /"odd-key": number \| null;/);
  assert.match(text, /id: string;/);
  assert.doesNotMatch(text, /checkout/, "a custom route is not a resource");
  assert.match(text, /line_items: \{ Row: LineItemsRow/);
});

test("a typed client checks names and rows at compile time", async () => {
  const fake = await serve(() => ({ status: 201, body: { id: 1, title: "x" } }));
  const db = createClient<Database>({ url: fake.url, apiKey: "pk", retry: false });
  await db.from("posts").create({ title: "ok", views: 3 });
  // @ts-expect-error title is required
  await db.from("posts").create({ views: 3 });
  // @ts-expect-error unknown resource
  db.from("nope");
  // @ts-expect-error views is a number
  await db.from("posts").create({ title: "t", views: "many" });
  // @ts-expect-error unknown column in a filter
  db.from("posts").eq("nope", 1);
  const row = await db.from("posts").get(1);
  const title: string = row.title;
  assert.equal(typeof title, "string");
  db.dispose();
});
