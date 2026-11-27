// E-02: start-up. A missing or unreadable organizer key file stops the API with one clear line
// on stderr and exit code 1, not a stack trace, and no line carries an environment value. A good
// key file starts it and health answers.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { listenUrl, parsePort } from "./index.ts";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const RFC_KEYPAIR = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];

const UNSET_LINE =
  "limen api: ORGANIZER_KEYPAIR_PATH is not set. Point it at the organizer keypair file (see .env.example).\n";

function runEntry(
  env: Record<string, string>,
  entry: string = ENTRY,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "limen-start-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("start-up with ORGANIZER_KEYPAIR_PATH unset exits 1 with one line naming the variable", () => {
  assert.deepEqual(runEntry({}), { status: 1, stdout: "", stderr: UNSET_LINE });
});

test("start-up with a missing key file exits 1 with one line naming the variable and ENOENT, not the path", () => {
  const missing = join(tmpdir(), "limen-no-such-dir", "organizer.json");
  assert.deepEqual(runEntry({ ORGANIZER_KEYPAIR_PATH: missing }), {
    status: 1,
    stdout: "",
    stderr:
      "limen api: The file ORGANIZER_KEYPAIR_PATH names cannot be read (ENOENT).\n",
  });
});

test(
  "start-up with an unreadable key file exits 1 with one line naming the variable and EACCES",
  { skip: process.getuid?.() === 0 ? "root ignores file modes" : false },
  () => {
    withTempDir((dir) => {
      const path = join(dir, "organizer.json");
      writeFileSync(path, JSON.stringify(RFC_KEYPAIR));
      chmodSync(path, 0o000);
      try {
        assert.deepEqual(runEntry({ ORGANIZER_KEYPAIR_PATH: path }), {
          status: 1,
          stdout: "",
          stderr:
            "limen api: The file ORGANIZER_KEYPAIR_PATH names cannot be read (EACCES).\n",
        });
      } finally {
        chmodSync(path, 0o600);
      }
    });
  },
);

test("start-up with the keypair JSON in ORGANIZER_KEYPAIR_PATH prints no byte of it", () => {
  const json = JSON.stringify(RFC_KEYPAIR);
  const { status, stdout, stderr } = runEntry({ ORGANIZER_KEYPAIR_PATH: json });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    "limen api: ORGANIZER_KEYPAIR_PATH holds what looks like key material, not a file path. Put the keypair in a file outside git and set the variable to that file's path.\n",
  );
  // No digit at all reaches stderr, so no byte value of the key can.
  assert.ok(!/[0-9]/.test(stderr));
  assert.ok(!stderr.includes(json));
});

test("start-up through a symlinked file or directory runs, rather than exiting 0 in silence", () => {
  withTempDir((dir) => {
    const linkFile = join(dir, "limen-api.ts");
    symlinkSync(ENTRY, linkFile);
    const linkDir = join(dir, "src-link");
    symlinkSync(dirname(ENTRY), linkDir);
    for (const entry of [linkFile, join(linkDir, "index.ts")]) {
      assert.deepEqual(
        runEntry({}, entry),
        { status: 1, stdout: "", stderr: UNSET_LINE },
        entry,
      );
    }
  });
});

test("API_PORT is 8787 when unset or empty, and otherwise an integer from 1 to 65535", () => {
  assert.equal(parsePort(undefined), 8787);
  assert.equal(parsePort(""), 8787);
  assert.equal(parsePort("1"), 1);
  assert.equal(parsePort("8080"), 8080);
  assert.equal(parsePort("65535"), 65535);
  for (const value of [
    " ",
    "0",
    "65536",
    "-1",
    "80a",
    "1e3",
    "0x50",
    " 80",
    "99999",
  ]) {
    assert.throws(
      () => parsePort(value),
      { message: "API_PORT must be an integer from 1 to 65535." },
      JSON.stringify(value),
    );
  }
});

test("start-up with a blank API_PORT exits 1 with one line, rather than binding a random port", () => {
  withTempDir((dir) => {
    const keyPath = join(dir, "organizer.json");
    writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
    assert.deepEqual(
      runEntry({ ORGANIZER_KEYPAIR_PATH: keyPath, API_PORT: " " }),
      {
        status: 1,
        stdout: "",
        stderr: "limen api: API_PORT must be an integer from 1 to 65535.\n",
      },
    );
  });
});

test("the printed address brackets an IPv6 host, so it parses as a URL", () => {
  assert.equal(listenUrl("::1", 8787), "http://[::1]:8787");
  assert.equal(new URL(listenUrl("::1", 8787)).hostname, "[::1]");
  assert.equal(listenUrl("127.0.0.1", 8787), "http://127.0.0.1:8787");
  assert.equal(listenUrl("localhost", 80), "http://localhost:80");
});

test("start-up with a good key file serves health with the API version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-start-"));
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH ?? "",
      ORGANIZER_KEYPAIR_PATH: keyPath,
      DATABASE_PATH: join(dir, "limen.db"),
      API_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const match =
          /^limen api 0\.1\.0 listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(
            out,
          );
        if (match?.[1]) resolve(match[1]);
      });
      child.once("exit", (code) =>
        reject(new Error(`API exited early with code ${code}`)),
      );
    });
    assert.equal(url, `http://127.0.0.1:${port}`);
    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ok",
      version: "0.1.0",
      schema_version: 1,
    });
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
