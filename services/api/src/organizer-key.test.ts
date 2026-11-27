// E-02: organizer key loading. A missing, unreadable or malformed key file fails with a clear
// error, and no error, log line or serialized form carries the key.
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";

import {
  loadOrganizerKey,
  OrganizerKeyError,
  type OrganizerKeyErrorCode,
} from "./organizer-key.ts";

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const RFC_SEED =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUBLIC =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_SIG_EMPTY =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

const rfcKeypairBytes = [...Buffer.from(RFC_SEED + RFC_PUBLIC, "hex")];
// A text marker that must never surface in an error: the seed as a JSON byte list.
const seedAsJson = JSON.stringify(rfcKeypairBytes.slice(0, 32)).slice(1, -1);

function withKeyFile(
  content: string,
  fn: (path: string, dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "limen-key-"));
  const path = join(dir, "organizer.json");
  writeFileSync(path, content);
  try {
    fn(path, dir);
  } finally {
    chmodSync(path, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertKeyError(
  fn: () => unknown,
  code: OrganizerKeyErrorCode,
  message: RegExp,
): OrganizerKeyError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof OrganizerKeyError,
    `expected OrganizerKeyError, got ${inspect(caught)}`,
  );
  assert.equal(caught.code, code);
  assert.match(caught.message, message);
  assert.equal(caught.cause, undefined, "no underlying error is attached");
  for (const shown of [caught.message, String(caught), inspect(caught)]) {
    assert.ok(
      !shown.includes(seedAsJson),
      "error output must not carry the seed bytes",
    );
    assert.ok(
      !shown.includes(RFC_SEED),
      "error output must not carry the seed in hex",
    );
  }
  return caught;
}

test("a solana-keygen keypair file loads to the public key and signatures RFC 8032 owes", () => {
  withKeyFile(JSON.stringify(rfcKeypairBytes), (path) => {
    const key = loadOrganizerKey(path);
    assert.equal(Buffer.from(key.publicKey).toString("hex"), RFC_PUBLIC);
    assert.equal(
      sign(null, Buffer.alloc(0), key.privateKey).toString("hex"),
      RFC_SIG_EMPTY,
    );
    assert.deepEqual([...key.secretKeyBytes()], rfcKeypairBytes);
  });
});

test("printing or serializing the loaded key shows the public key and never the seed", () => {
  withKeyFile(JSON.stringify(rfcKeypairBytes), (path) => {
    const key = loadOrganizerKey(path);
    for (const shown of [
      inspect(key),
      JSON.stringify(key),
      String(key),
      `${inspect({ key })}`,
    ]) {
      assert.ok(!shown.includes(seedAsJson), `seed bytes leaked in: ${shown}`);
      assert.ok(!shown.includes(RFC_SEED), `seed hex leaked in: ${shown}`);
    }
    assert.equal(inspect(key), `OrganizerKey { publicKey: ${RFC_PUBLIC} }`);
    assert.equal(JSON.stringify(key), `{"publicKey":"${RFC_PUBLIC}"}`);
  });
});

test("an unset ORGANIZER_KEYPAIR_PATH fails with the unset error", () => {
  assertKeyError(
    () => loadOrganizerKey(undefined),
    "unset",
    /^ORGANIZER_KEYPAIR_PATH is not set\./,
  );
  assertKeyError(
    () => loadOrganizerKey("  "),
    "unset",
    /^ORGANIZER_KEYPAIR_PATH is not set\./,
  );
});

test("a missing key file fails with the unreadable error naming the path and ENOENT", () => {
  const missing = join(tmpdir(), "limen-no-such-dir", "organizer.json");
  assertKeyError(
    () => loadOrganizerKey(missing),
    "unreadable",
    new RegExp(
      `^organizer keypair file ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} cannot be read \\(ENOENT\\)\\.$`,
    ),
  );
});

test("a directory in place of the key file fails with the unreadable error and EISDIR", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-key-"));
  try {
    const sub = join(dir, "organizer.json");
    mkdirSync(sub);
    assertKeyError(
      () => loadOrganizerKey(sub),
      "unreadable",
      /cannot be read \(EISDIR\)\.$/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a key file without read permission fails with the unreadable error and EACCES",
  { skip: process.getuid?.() === 0 ? "root ignores file modes" : false },
  () => {
    withKeyFile(JSON.stringify(rfcKeypairBytes), (path) => {
      chmodSync(path, 0o000);
      assertKeyError(
        () => loadOrganizerKey(path),
        "unreadable",
        /cannot be read \(EACCES\)\.$/,
      );
    });
  },
);

test("malformed key files fail with the malformed error and never echo their content", () => {
  const malformed = [
    `not json ${seedAsJson}`,
    `[${seedAsJson}`,
    JSON.stringify(rfcKeypairBytes.slice(0, 63)),
    JSON.stringify([...rfcKeypairBytes, 0]),
    JSON.stringify([...rfcKeypairBytes.slice(0, 63), 256]),
    JSON.stringify([...rfcKeypairBytes.slice(0, 63), -1]),
    JSON.stringify([...rfcKeypairBytes.slice(0, 63), 1.5]),
    JSON.stringify([...rfcKeypairBytes.slice(0, 63), "7"]),
    JSON.stringify({ secretKey: rfcKeypairBytes }),
    "",
  ];
  for (const content of malformed) {
    withKeyFile(content, (path) => {
      assertKeyError(
        () => loadOrganizerKey(path),
        "malformed",
        /is not a Solana keypair: expected a JSON array of 64 integers from 0 to 255\.$/,
      );
    });
  }
});

test("a key file whose public half does not match its secret half fails with the mismatch error", () => {
  const wrongPublic = [
    ...rfcKeypairBytes.slice(0, 32),
    ...new Array<number>(32).fill(0),
  ];
  withKeyFile(JSON.stringify(wrongPublic), (path) => {
    assertKeyError(
      () => loadOrganizerKey(path),
      "mismatch",
      /is inconsistent: its public key does not match its secret key\.$/,
    );
  });
});
