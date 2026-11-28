// E-03: the station build, one self-contained index.html that the API serves at /station.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));

/** Builds the page into a fresh folder in a child process with `env`; returns the folder. */
function buildWith(env: Record<string, string>): string {
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { build } from "vite";
await build({ configFile: process.argv[1], root: process.argv[2], logLevel: "silent", build: { outDir: process.argv[3] } });`,
      join(APP, "vite.config.ts"),
      APP,
      outDir,
    ],
    {
      cwd: APP,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
      timeout: 120_000,
    },
  );
  assert.equal(r.status, 0, `build: ${r.stderr.slice(-600)}`);
  return outDir;
}

test("the build writes one self-contained index.html: its script inline, no other file, nothing loaded from elsewhere", () => {
  const outDir = buildWith({});
  try {
    assert.deepEqual(readdirSync(outDir, { recursive: true }), ["index.html"]);
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, [' type="module"'], "one inline module script");
    assert.doesNotMatch(html, /<link\b/);
    assert.doesNotMatch(html, /\s(src|href)="(?!data:)/);
    // The page's own markup and code are in it.
    assert.match(html, /<canvas id="qr" hidden><\/canvas>/);
    assert.match(html, /\/stations\//);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("the build loads no environment: a secret and a STATION_API_URL_LABEL set for it are not in the page", () => {
  const values = {
    STATION_DISPLAY_TOKEN: "build-env-secret-0123456789abcdefghij",
    STATION_API_URL_LABEL: "build-env-label-7f3a",
    VITE_STATION_SECRET: "build-env-vite-secret-91c2",
  };
  const outDir = buildWith(values);
  try {
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    for (const [name, value] of Object.entries(values))
      assert.ok(!html.includes(value), `${name}'s value is in the page`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  const sources = [
    "vite.config.ts",
    ...readdirSync(join(APP, "src"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join("src", f)),
  ];
  for (const file of sources) {
    const text = readFileSync(join(APP, file), "utf8");
    assert.ok(!text.includes("loadEnv"), `${file} calls loadEnv`);
    assert.ok(
      !text.includes("import.meta.env"),
      `${file} reads import.meta.env`,
    );
  }
});
