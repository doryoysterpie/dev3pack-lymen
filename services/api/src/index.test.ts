// E-02: start-up. A missing or unreadable organizer key file stops the API with one clear line
// on stderr and exit code 1, not a stack trace. A good key file starts it and health answers.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const RFC_KEYPAIR = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];

function runEntry(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [ENTRY], {
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

test("start-up with ORGANIZER_KEYPAIR_PATH unset exits 1 with one line naming the variable", () => {
  const { status, stdout, stderr } = runEntry({});
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    "limen api: ORGANIZER_KEYPAIR_PATH is not set. Point it at the organizer keypair file (see .env.example).\n",
  );
});

test("start-up with a missing key file exits 1 with one line naming the path and ENOENT", () => {
  const missing = join(tmpdir(), "limen-no-such-dir", "organizer.json");
  const { status, stdout, stderr } = runEntry({
    ORGANIZER_KEYPAIR_PATH: missing,
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    `limen api: organizer keypair file ${missing} cannot be read (ENOENT).\n`,
  );
});

test(
  "start-up with an unreadable key file exits 1 with one line naming the path and EACCES",
  { skip: process.getuid?.() === 0 ? "root ignores file modes" : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "limen-key-"));
    const path = join(dir, "organizer.json");
    writeFileSync(path, JSON.stringify(RFC_KEYPAIR));
    chmodSync(path, 0o000);
    try {
      const { status, stdout, stderr } = runEntry({
        ORGANIZER_KEYPAIR_PATH: path,
      });
      assert.equal(status, 1);
      assert.equal(stdout, "");
      assert.equal(
        stderr,
        `limen api: organizer keypair file ${path} cannot be read (EACCES).\n`,
      );
    } finally {
      chmodSync(path, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("start-up with a good key file serves health with the API version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-start-"));
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH ?? "",
      ORGANIZER_KEYPAIR_PATH: keyPath,
      DATABASE_PATH: join(dir, "limen.db"),
      API_PORT: "0",
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
