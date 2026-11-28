// E-03: the station build, one self-contained index.html that the API serves at /station.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));

/** Builds the page with `npm run build`'s script into a fresh folder, with `env` set for it. */
function buildWith(env: Record<string, string>): string {
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  const r = spawnSync(
    process.execPath,
    [join(APP, "build.ts"), "--outDir", outDir],
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
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    assert.deepEqual(scripts, [' type="module"'], "one inline module script");
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /\s(src|href)="(?!data:)/i);
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

test("the inliner refuses a script holding </script, <script or <!-- in any case, which would change how the page parses", async () => {
  const { inlineScript } = await import("../vite.config.ts");
  const run = (code: string) => {
    const bundle: Record<string, unknown> = {
      "index.html": {
        type: "asset",
        source:
          '<html><script type="module" crossorigin src="/assets/a.js"></script></html>',
      },
      "assets/a.js": { type: "chunk", fileName: "assets/a.js", code },
    };
    const hook = inlineScript().generateBundle as unknown as (
      this: { error(message: string): never },
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void;
    hook.call(
      {
        error: (message: string) => {
          throw new Error(message);
        },
      },
      {},
      bundle,
    );
    return (bundle["index.html"] as { source: string }).source;
  };
  for (const code of [
    'const a = "</SCRIPT>";',
    'const a = "</Script ";',
    'const a = "<script>";',
    'const a = "<!--";',
  ])
    assert.throws(() => run(code), /holds/, code);
  assert.equal(
    run("console.log(1);"),
    '<html><script type="module">console.log(1);</script></html>',
  );
});

test("the build runs Vite with PATH and NODE_ENV alone: a VITE_ variable and DEBUG=vite:env set for it reach neither its output nor the page", () => {
  const label = "vite-secret-label-5e1b";
  const env = { VITE_SECRET_LABEL: label, DEBUG: "vite:env" };
  const viteBin = join(
    dirname(createRequire(import.meta.url).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
  const control = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  try {
    // Control: Vite run directly with that environment prints the label.
    const direct = spawnSync(
      process.execPath,
      [viteBin, "build", "--outDir", control],
      {
        cwd: APP,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", ...env },
        timeout: 120_000,
      },
    );
    assert.ok(
      (direct.stdout + direct.stderr).includes(label),
      "control: Vite run directly prints the label",
    );
  } finally {
    rmSync(control, { recursive: true, force: true });
  }
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  try {
    const r = spawnSync(
      process.execPath,
      [join(APP, "build.ts"), "--outDir", outDir],
      {
        cwd: APP,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", ...env },
        timeout: 120_000,
      },
    );
    assert.equal(r.status, 0, r.stderr.slice(-600));
    assert.ok(!(r.stdout + r.stderr).includes(label), "the label is printed");
    assert.ok(
      !readFileSync(join(outDir, "index.html"), "utf8").includes(label),
      "the label is in the page",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
