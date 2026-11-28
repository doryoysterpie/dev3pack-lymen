// Builds the station page (E-03): `node apps/station/build.ts`. Vite runs in a child process
// given { PATH, NODE_ENV: "production" }, to which Node adds NODE_V8_COVERAGE when non-empty in
// the parent; no other variable from the caller reaches the child (src/build.test.ts).
// Arguments, such as --outDir, pass through to `vite build`.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vite = join(
  dirname(createRequire(import.meta.url).resolve("vite/package.json")),
  "bin",
  "vite.js",
);
const result = spawnSync(
  process.execPath,
  [vite, "build", ...process.argv.slice(2)],
  {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
