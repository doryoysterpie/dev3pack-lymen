// E-03: the station link tool writes a station's page address with its own display token, and
// prints neither the token nor the secret (rule 8).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("the link tool refuses to write inside the repository, where the station page's dev server could serve the file", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const owed =
    "station-link: the link file must be outside the repository, where the station page's dev server cannot serve it.\n";
  const dir = mkdtempSync(join(tmpdir(), "limen-link-"));
  // A path outside the repository that leads back into it through a symlink is refused too.
  symlinkSync(repo, join(dir, "into-repo"));
  const outs = [
    join(repo, ".station-links", "refused-test.url"),
    join(repo, "apps", "station", "refused-test.url"),
    join(repo, "refused-test.url"),
    join(dir, "into-repo", "refused-test.url"),
  ];
  const hadLinkDir = existsSync(join(repo, ".station-links"));
  try {
    for (const out of outs) {
      const refused = run(["st-front", out]);
      assert.deepEqual(
        {
          status: refused.status,
          stdout: refused.stdout,
          stderr: refused.stderr,
        },
        { status: 1, stdout: "", stderr: owed },
        out,
      );
      assert.equal(existsSync(out), false, `${out} was not written`);
    }
  } finally {
    // Nothing should have been written; a failing run must not leave a file in the repository.
    for (const out of outs) rmSync(out, { force: true });
    if (!hadLinkDir)
      rmSync(join(repo, ".station-links"), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "the link tool refuses the repository's path written in another letter case, on macOS",
  {
    skip: process.platform !== "darwin",
  },
  () => {
    // APFS is case-insensitive by default, so another case names the same folder.
    const repo = realpathSync(
      fileURLToPath(new URL("../../../", import.meta.url)),
    );
    const name = `case-test-${process.pid}.url`;
    const swapped = [...repo]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    assert.notEqual(swapped, repo);
    const inside = join(repo, name);
    try {
      const refused = run(["st-front", join(swapped, name)]);
      assert.deepEqual(
        {
          status: refused.status,
          stdout: refused.stdout,
          stderr: refused.stderr,
        },
        {
          status: 1,
          stdout: "",
          stderr:
            "station-link: the link file must be outside the repository, where the station page's dev server cannot serve it.\n",
        },
      );
      assert.equal(
        existsSync(inside),
        false,
        "nothing was written in the repository",
      );
    } finally {
      rmSync(inside, { force: true });
    }
  },
);

test("the link tool refuses a path through a symlink that does not resolve, such as one pointing into the repository", () => {
  const repo = realpathSync(
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const target = join(repo, `dangling-test-${process.pid}.url`);
  const dir = mkdtempSync(join(tmpdir(), "limen-link-"));
  const link = join(dir, "link.url");
  symlinkSync(target, link);
  // A symlinked folder that does not resolve, with the file named under it.
  symlinkSync(join(repo, `dangling-dir-${process.pid}`), join(dir, "into"));
  try {
    for (const out of [link, join(dir, "into", "st-front.url")]) {
      const refused = run(["st-front", out]);
      assert.deepEqual(
        {
          status: refused.status,
          stdout: refused.stdout,
          stderr: refused.stderr,
        },
        {
          status: 1,
          stdout: "",
          stderr:
            "station-link: the link file's path holds a symlink that does not resolve; name a path without one.\n",
        },
        out,
      );
    }
    assert.equal(
      existsSync(target),
      false,
      "nothing was written through the link",
    );
    assert.equal(existsSync(join(repo, `dangling-dir-${process.pid}`)), false);
  } finally {
    rmSync(target, { force: true });
    rmSync(join(repo, `dangling-dir-${process.pid}`), {
      recursive: true,
      force: true,
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the link tool never writes into an existing file, so no token sits in a file another user could read", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-link-"));
  const out = join(dir, "st-front.url");
  writeFileSync(out, "old\n");
  chmodSync(out, 0o644);
  try {
    const refused = run(["st-front", out]);
    assert.deepEqual(
      {
        status: refused.status,
        stdout: refused.stdout,
        stderr: refused.stderr,
      },
      {
        status: 1,
        stdout: "",
        stderr:
          "station-link: the link file already exists; remove it or name another file.\n",
      },
    );
    assert.equal(readFileSync(out, "utf8"), "old\n");
    assert.equal(statSync(out).mode & 0o777, 0o644);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
