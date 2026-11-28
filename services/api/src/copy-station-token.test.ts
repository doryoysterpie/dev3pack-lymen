// E-03: the station-token tool. Each test runs it as a child process with a stub pbcopy alone on
// PATH, and process.platform set by an --import module so the macOS path runs on any runner. No
// test may reach the real pbcopy: the guards below stop a test before the tool runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { copyStationToken } from "./copy-station-token.ts";

const ENTRY = fileURLToPath(
  new URL("./copy-station-token.ts", import.meta.url),
);
const SECRET = "test-display-token-0123456789abcdef";
// HMAC-SHA256 of "limen:station-display:v1:st-front" under SECRET, from Python's hmac.
const FRONT_TOKEN = "lWbhFKhap4ZM9Ptol3mb5KYvWJUs8yXG84tELGGMwwQ";
/** Folders where a real pbcopy lives, or could, which no test PATH may hold. */
const SYSTEM_FOLDERS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/usr/local/bin",
];

before(() => {
  // The tool runs pbcopy by its bare name, and names no pbcopy by an absolute path.
  const source = readFileSync(ENTRY, "utf8");
  assert.match(source, /\bspawn\(\s*"pbcopy"/, "the tool runs pbcopy by name");
  assert.doesNotMatch(
    source,
    /\/pbcopy\b/,
    "the tool names no absolute pbcopy path",
  );
});

/**
 * Throws, before the tool runs, unless `path` is set, holds no system folder, and reaches exactly
 * `expected` as its pbcopy (null: none at all).
 */
function assertOnlyStub(path: string, expected: string | null): void {
  const folders = path.split(delimiter);
  assert.ok(
    path !== "" && folders.every((f) => f !== ""),
    "PATH is set, with no empty entry, so no default search path applies",
  );
  for (const folder of folders)
    assert.ok(
      !SYSTEM_FOLDERS.includes(resolve(folder)),
      `PATH holds the system folder ${folder}`,
    );
  const reachable = folders
    .map((f) => join(f, "pbcopy"))
    .filter((f) => existsSync(f))
    .map((f) => realpathSync(f));
  assert.deepEqual(
    reachable,
    expected === null ? [] : [realpathSync(expected)],
    "the stub is the one pbcopy on PATH",
  );
  if (existsSync("/usr/bin/pbcopy"))
    assert.ok(!reachable.includes(realpathSync("/usr/bin/pbcopy")));
}

const USAGE =
  "station-token: usage: npm run station-token -w @limen/api -- <station ID>\n";

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** What the stub pbcopy read on stdin, or null if it did not run. */
  readonly copied: string | null;
  /** The arguments the stub pbcopy was given, one per line, or null if it did not run. */
  readonly argv: string | null;
}

function run(
  args: string[],
  options: {
    platform?: string;
    secret?: string | null;
    pbcopyExit?: number;
    pbcopy?: boolean;
    env?: Record<string, string>;
  } = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), "limen-station-token-"));
  try {
    const bin = join(dir, "bin");
    const stub = join(bin, "pbcopy");
    if (options.pbcopy !== false) {
      mkdirSync(bin);
      writeFileSync(
        stub,
        `#!/bin/sh\nPATH=/bin:/usr/bin\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/copied"\nexit ${options.pbcopyExit ?? 0}\n`,
      );
      chmodSync(stub, 0o755);
    }
    const path = bin;
    // Fail closed: with any other pbcopy reachable, the test stops here, before the tool runs.
    assertOnlyStub(path, options.pbcopy === false ? null : stub);
    const platform = options.platform ?? "darwin";
    const secret = options.secret === undefined ? SECRET : options.secret;
    const result = spawnSync(
      process.execPath,
      [
        `--import=data:text/javascript,Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}})`,
        ENTRY,
        ...args,
      ],
      {
        env: {
          ...options.env,
          PATH: path,
          ...(secret === null ? {} : { STATION_DISPLAY_TOKEN: secret }),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const read = (name: string) =>
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8")
        : null;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      copied: read("copied"),
      argv: read("argv"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the guard refuses, without running anything, a PATH that could reach a pbcopy other than the stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-station-token-"));
  try {
    const bin = join(dir, "bin");
    const other = join(dir, "other");
    mkdirSync(bin);
    mkdirSync(other);
    const stub = join(bin, "pbcopy");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    writeFileSync(join(other, "pbcopy"), "#!/bin/sh\nexit 0\n");
    // The PATH each run uses passes.
    assertOnlyStub(bin, stub);
    assertOnlyStub(join(dir, "missing"), null);
    // A system folder, an empty PATH or entry, a second pbcopy, and no stub where one is owed.
    for (const [path, expected] of [
      [`${bin}${delimiter}/usr/bin`, stub],
      [`${bin}${delimiter}/bin`, stub],
      ["", stub],
      [`${bin}${delimiter}`, stub],
      [`${bin}${delimiter}${other}`, stub],
      [join(dir, "missing"), stub],
      [other, null],
    ] as const)
      assert.throws(() => assertOnlyStub(path, expected), JSON.stringify(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on macOS the tool pipes the station's token to pbcopy's stdin and prints only that it did", () => {
  const r = run(["st-front"]);
  assert.deepEqual(r, {
    status: 0,
    stdout: "Copied the display token for st-front.\n",
    stderr: "",
    copied: FRONT_TOKEN,
    // pbcopy was given no arguments: the token is not on its command line.
    argv: "\n",
  });
});

test("the token and the secret appear in neither stdout nor stderr, whatever the outcome", () => {
  const outcomes = [
    run(["st-front"]),
    run(["st-front"], { pbcopyExit: 1 }),
    run(["st-front"], { pbcopy: false }),
    run(["st-front"], { platform: "linux" }),
    run(["st-front", "extra"]),
    run(["st-front"], { secret: "q7Zx3" }),
  ];
  for (const r of outcomes)
    for (const value of [FRONT_TOKEN, SECRET, "q7Zx3"])
      assert.ok(
        !r.stdout.includes(value) && !r.stderr.includes(value),
        JSON.stringify(r),
      );
});

test("off macOS the tool refuses with a clear message, and runs no pbcopy", () => {
  for (const platform of ["linux", "win32"]) {
    const r = run(["st-front"], { platform });
    assert.deepEqual(
      { status: r.status, stdout: r.stdout, copied: r.copied },
      { status: 1, stdout: "", copied: null },
    );
    assert.equal(
      r.stderr,
      "station-token: this tool copies the token with pbcopy, which is on macOS only; run it on a Mac.\n",
    );
  }
});

test("a failed or missing pbcopy is reported as a pbcopy that did not exit 0", () => {
  for (const r of [
    run(["st-front"], { pbcopyExit: 1 }),
    run(["st-front"], { pbcopy: false }),
  ]) {
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(
      r.stderr,
      "station-token: pbcopy did not run to exit status 0, so the clipboard may not hold the token.\n",
    );
  }
});

test("the tool takes exactly one station ID of 1 to 64 characters of [A-Za-z0-9_-]", () => {
  for (const args of [
    [],
    ["st-front", "extra"],
    ["st front"],
    [".."],
    ["a/b"],
    ["x".repeat(65)],
  ]) {
    const r = run(args);
    assert.deepEqual(r, {
      status: 1,
      stdout: "",
      stderr: USAGE,
      copied: null,
      argv: null,
    });
  }
});

test("a missing or short secret is refused without echoing it, and pbcopy does not run", () => {
  for (const secret of [null, "", "short"]) {
    const r = run(["st-front"], { secret });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.copied, null);
    assert.match(r.stderr, /^station-token: STATION_DISPLAY_TOKEN must be set/);
  }
});

test("with NODE_DEBUG=child_process and NODE_OPTIONS set, stderr holds neither the token nor the secret", () => {
  for (const debug of ["child_process", "*"]) {
    const r = run(["st-front"], {
      env: { NODE_DEBUG: debug, NODE_OPTIONS: "--no-deprecation" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.copied, FRONT_TOKEN);
    for (const value of [FRONT_TOKEN, SECRET])
      assert.ok(
        !r.stderr.includes(value) && !r.stdout.includes(value),
        `NODE_DEBUG=${debug}: ${r.stderr.slice(0, 400)}`,
      );
  }
});

test("with PATH unset or empty the tool refuses before it looks for pbcopy", async () => {
  for (const env of [
    { STATION_DISPLAY_TOKEN: SECRET },
    { STATION_DISPLAY_TOKEN: SECRET, PATH: "" },
  ])
    await assert.rejects(copyStationToken(env, ["st-front"], "darwin"), {
      message: "PATH is not set, so pbcopy cannot be found.",
    });
});
