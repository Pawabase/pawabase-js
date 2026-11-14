import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { generateTypes } from "../typegen.js";

const USAGE = `pawabase-types: generate TypeScript types for createClient<Database>()

Usage:
  pawabase-types --url <gateway> --env <name> --api-key <key> [--out types.ts]
  pawabase-types --url <gateway> --env <name> [--out types.ts]       (public API reference on)
  pawabase-types --file openapi.json [--out types.ts]

Options:
  --url, -u       The gateway origin             (env PAWABASE_URL)
  --env, -e       The environment's full name    (env PAWABASE_ENV)
  --project, -p   The project's id (or PAWABASE_PROJECT): checked against the key, and used to name the environment without one
  --api-key, -k   An API key, sent as 'apikey'   (env PAWABASE_API_KEY)
  --file, -f      Read the OpenAPI document from a file instead of the gateway
  --out, -o       Where to write the types. Default: pawabase.types.ts. '-' prints them.
  --name          The root interface's name. Default: Database
  --check         Exit 1 if --out is out of date (for CI); writes nothing
  --help, -h      Show this

With an API key the document is read from /rest/v1/openapi.json, as that key sees
it. Without one it is read from /docs/v1/<env>/openapi.json, which the gateway
serves only when the environment's "Publish the API reference" setting is on.
`;

function parse(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const alias: Record<string, string> = { u: "url", p: "project", e: "env", k: "api-key", f: "file", o: "out", h: "help" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) continue;
    const name = arg.startsWith("--") ? arg.slice(2) : (alias[arg.slice(1)] ?? arg.slice(1));
    if (name === "help" || name === "check") out[name] = true;
    else out[name] = argv[++i] ?? "";
  }
  return out;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args["help"]) {
    console.log(USAGE);
    return 0;
  }
  const file = args["file"] as string | undefined;
  const url = (args["url"] as string | undefined) ?? process.env["PAWABASE_URL"];
  const project = (args["project"] as string | undefined) ?? process.env["PAWABASE_PROJECT"];
  const env = (args["env"] as string | undefined) ?? process.env["PAWABASE_ENV"];
  const apiKey = (args["api-key"] as string | undefined) ?? process.env["PAWABASE_API_KEY"];

  let spec: unknown;
  let source: string;
  if (file) {
    spec = JSON.parse(readFileSync(file, "utf8"));
    source = file;
  } else {
    if (!url || !env) {
      console.error("Give --url and --env (or --file).\n\n" + USAGE);
      return 2;
    }
    const base = url.replace(/\/+$/, "");
    // Without a key the environment is in the path: `<project>.<environment>` when the project is given, its full name otherwise.
    const segment = project ? `${project}.${env}` : env;
    const endpoint = apiKey ? `${base}/rest/v1/openapi.json` : `${base}/docs/v1/${encodeURIComponent(segment)}/openapi.json`;
    const headers: Record<string, string> = apiKey ? { apikey: apiKey, "x-environment": env, ...(project ? { "x-project-id": project } : {}) } : {};
    const response = await fetch(endpoint, { headers });
    if (!response.ok) {
      console.error(
        `Could not read ${endpoint}: ${response.status}. ` +
          (apiKey
            ? "Check the key belongs to this project and reaches this environment."
            : "Pass --api-key, turn on \"Publish the API reference\" for this environment, or use --file."),
      );
      return 1;
    }
    spec = await response.json();
    source = endpoint;
  }

  const text = generateTypes(spec as Record<string, unknown>, {
    ...(args["name"] ? { name: String(args["name"]) } : {}),
    source,
  });
  const out = (args["out"] as string | undefined) ?? "pawabase.types.ts";
  if (out === "-") {
    process.stdout.write(text);
    return 0;
  }
  if (args["check"]) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : "";
    // The header names the source and version; compare the body only.
    const body = (value: string) => value.split("\n").slice(3).join("\n");
    if (body(current) !== body(text)) {
      console.error(`${out} is out of date. Run pawabase-types again.`);
      return 1;
    }
    console.log(`${out} is up to date.`);
    return 0;
  }
  writeFileSync(out, text);
  console.log(`Wrote ${out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
