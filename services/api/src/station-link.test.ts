// E-03: the station link tool writes a station's page address, with that station's own display
// token, to ~/limen-station-links/<station ID>.url, and prints neither the token nor the secret
// (rule 8). It takes no output path. Each test runs the real tool with HOME set to a fresh
// temporary folder, so nothing outside it is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { writeStationLink } from "./station-link.ts";

const ENTRY = fileURLToPath(new URL("./station-link.ts", import.meta.url));
const SECRET = "test-display-token-0123456789abcdef";
// HMAC-SHA256 of "limen:station-display:v1:st-front" under SECRET, from Python's hmac.
const FRONT_TOKEN = "lWbhFKhap4ZM9Ptol3mb5KYvWJUs8yXG84tELGGMwwQ";
const USAGE =
  "station-link: usage: npm run station-link -w @limen/api -- <station ID>\n";

/** Runs the tool with HOME set to `home`; `secret` null leaves STATION_DISPLAY_TOKEN unset. */
function run(home: string, args: string[], secret: string | null = SECRET) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
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

function withHome(body: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "limen-link-home-"));
  try {
    body(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const folder = (home: string) => join(home, "limen-station-links");

test("the link tool writes the station's own link into ~/limen-station-links, made at mode 700, the file readable by its owner only, and prints no token", () => {
  withHome((home) => {
    const result = run(home, ["st-front"]);
    const out = join(folder(home), "st-front.url");
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
    assert.equal(statSync(folder(home)).mode & 0o777, 0o700);
    for (const secret of [FRONT_TOKEN, SECRET])
      assert.ok(
        !result.stdout.includes(secret) && !result.stderr.includes(secret),
      );
  });
});

test("the link tool takes no output path: a second argument is refused, and nothing is written", () => {
  withHome((home) => {
    const elsewhere = join(home, "elsewhere.url");
    assert.deepEqual(run(home, ["st-front", elsewhere]), {
      status: 1,
      stdout: "",
      stderr: USAGE,
    });
    assert.equal(existsSync(elsewhere), false);
    assert.equal(existsSync(folder(home)), false);
  });
});

test("a station ID with '..', '/', a dot or any character outside [A-Za-z0-9_-], or over 64 characters, is refused", () => {
  withHome((home) => {
    for (const id of [
      "..",
      "../st-front",
      "st/front",
      "st.front",
      ".hidden",
      "st front",
      "st-front\n",
      "",
      "é",
      "a".repeat(65),
    ]) {
      assert.deepEqual(
        run(home, [id]),
        { status: 1, stdout: "", stderr: USAGE },
        JSON.stringify(id),
      );
    }
    assert.deepEqual(readdirSync(home), []);
  });
});

test("the link tool refuses a missing or short secret without printing it", () => {
  withHome((home) => {
    const unset = run(home, ["st-front"], null);
    assert.equal(unset.status, 1);
    assert.match(
      unset.stderr,
      /^station-link: STATION_DISPLAY_TOKEN must be set to at least 32 characters \(it is not set\)\./,
    );
    const short = run(home, ["st-front"], "short-secret");
    assert.equal(short.status, 1);
    assert.ok(!short.stderr.includes("short-secret"));
  });
});

test("the link folder is refused when it is a symlink, not a directory, or writable by group or others", () => {
  const cases: [string, (home: string) => void, string][] = [
    [
      "a symlink",
      (home) => {
        mkdirSync(join(home, "real"), { mode: 0o700 });
        symlinkSync(join(home, "real"), folder(home));
      },
      "a symlink",
    ],
    [
      "a file",
      (home) => writeFileSync(folder(home), "not a folder\n"),
      "not a directory",
    ],
    [
      "group-writable",
      (home) => {
        mkdirSync(folder(home));
        chmodSync(folder(home), 0o770);
      },
      "writable by group or others",
    ],
    [
      "world-writable",
      (home) => {
        mkdirSync(folder(home));
        chmodSync(folder(home), 0o703);
      },
      "writable by group or others",
    ],
  ];
  for (const [name, prepare, why] of cases) {
    withHome((home) => {
      prepare(home);
      assert.deepEqual(
        run(home, ["st-front"]),
        {
          status: 1,
          stdout: "",
          stderr: `station-link: ${folder(home)} must be a directory owned by you and writable by you only; it is ${why}.\n`,
        },
        name,
      );
      assert.equal(existsSync(join(home, "real", "st-front.url")), false);
      if (name !== "a file" && name !== "a symlink")
        assert.deepEqual(readdirSync(folder(home)), []);
    });
  }
});

test("the link folder is refused when another user owns it", () => {
  withHome((home) => {
    mkdirSync(folder(home), { mode: 0o700 });
    // The uid the folder must belong to is passed in, as a stand-in for another user's folder.
    assert.throws(
      () =>
        writeStationLink({ STATION_DISPLAY_TOKEN: SECRET }, ["st-front"], {
          home,
          uid: (process.getuid?.() ?? 0) + 1,
        }),
      {
        message: `${folder(home)} must be a directory owned by you and writable by you only; it is owned by another user.`,
      },
    );
    assert.deepEqual(readdirSync(folder(home)), []);
  });
});

test("the link tool never writes into an existing link file", () => {
  withHome((home) => {
    mkdirSync(folder(home), { mode: 0o700 });
    const out = join(folder(home), "st-front.url");
    writeFileSync(out, "old\n");
    chmodSync(out, 0o644);
    assert.deepEqual(run(home, ["st-front"]), {
      status: 1,
      stdout: "",
      stderr:
        "station-link: the link file already exists; remove it and run the tool again.\n",
    });
    assert.equal(readFileSync(out, "utf8"), "old\n");
    assert.equal(statSync(out).mode & 0o777, 0o644);
  });
});
