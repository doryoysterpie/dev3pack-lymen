// E-03: the station link tool writes a station's page address with its own display token, and
// prints neither the token nor the secret (rule 8).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./station-link.ts", import.meta.url));
const SECRET = "test-display-token-0123456789abcdef";
// HMAC-SHA256 of "limen:station-display:v1:st-front" under SECRET, from Python's hmac.
const FRONT_TOKEN = "lWbhFKhap4ZM9Ptol3mb5KYvWJUs8yXG84tELGGMwwQ";

/** Runs the tool; `secret` null leaves STATION_DISPLAY_TOKEN unset. */
function run(args: string[], secret: string | null = SECRET) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      ...(secret === null ? {} : { STATION_DISPLAY_TOKEN: secret }),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("the link tool writes the station's own link, readable by its owner only, and prints no token", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-link-"));
  try {
    const out = join(dir, "links", "st-front.url");
    const result = run(["st-front", out]);
    assert.deepEqual(result, {
      status: 0,
      stdout: `Wrote the display link for station st-front to ${out}.\n`,
      stderr: "",
    });
    assert.equal(
      readFileSync(out, "utf8"),
      `http://127.0.0.1:5173/?station=st-front#token=${FRONT_TOKEN}\n`,
    );
    assert.equal(statSync(out).mode & 0o777, 0o600);
    for (const secret of [FRONT_TOKEN, SECRET])
      assert.ok(
        !result.stdout.includes(secret) && !result.stderr.includes(secret),
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the link tool refuses a bad station ID or a missing secret without printing a secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-link-"));
  try {
    const usage = run(["st front", join(dir, "a.url")]);
    assert.equal(usage.status, 1);
    assert.equal(
      usage.stderr,
      "station-link: usage: npm run station-link -w @limen/api -- <station ID> <output file>\n",
    );
    const unset = run(["st-front", join(dir, "b.url")], null);
    assert.equal(unset.status, 1);
    assert.match(
      unset.stderr,
      /^station-link: STATION_DISPLAY_TOKEN must be set to at least 32 characters \(it is not set\)\./,
    );
    const short = run(["st-front", join(dir, "c.url")], "short-secret");
    assert.equal(short.status, 1);
    assert.ok(!short.stderr.includes("short-secret"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
