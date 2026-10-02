// The CommonJS build lives in dist/cjs and must be told it is CommonJS,
// because the package itself is "type": "module".
import { writeFileSync, chmodSync, readFileSync } from "node:fs";

writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }) + "\n");
writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }) + "\n");

const cli = "dist/esm/cli/gen-types.js";
const source = readFileSync(cli, "utf8");
if (!source.startsWith("#!")) writeFileSync(cli, `#!/usr/bin/env node\n${source}`);
chmodSync(cli, 0o755);
