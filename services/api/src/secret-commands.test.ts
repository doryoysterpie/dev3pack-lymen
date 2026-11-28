// Rule 8: the command the docs give for making a secret must not print it. For each secret in
// .env.example (E-03's STATION_DISPLAY_TOKEN and E-07's REGISTRATION_SALT) this runs the command
// .env.example documents and the one the start-up diagnostic recommends, in a copy of the
// repository's .env.example, and owes that each prints nothing and leaves a fresh value of at
// least 32 characters that Node reads from .env.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadRegistrationSalt } from "./registration.ts";

const EXAMPLE = readFileSync(
  new URL("../../../.env.example", import.meta.url),
  "utf8",
);
const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const RFC_KEYPAIR = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];

/** The command .env.example documents for `name`: the comment line just above `name=`. */
function documentedCommand(name: string): string {
  const lines = EXAMPLE.split("\n");
  const at = lines.indexOf(`${name}=`);
  assert.ok(at > 0, `.env.example has a ${name}= line`);
  const comment = lines[at - 1]!;
  assert.match(comment, /^#/, `a comment sits above ${name}=`);
  return comment
    .replace(/^#\s*/, "")
    .replace(/^.*Generate with:\s*/, "")
    .trim();
}

/** The command a diagnostic recommends: the text after its last ": ". */
function recommendedCommand(message: string): string {
  return message.slice(message.lastIndexOf(": ") + 2).trim();
}

/** Runs `command` with sh in a copy of .env.example; returns its output and what Node then reads. */
function runInCopy(command: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "limen-secret-"));
  try {
    writeFileSync(join(dir, ".env"), EXAMPLE);
    const run = spawnSync("sh", ["-c", command], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    const read = spawnSync(
      process.execPath,
      [
        `--env-file=${join(dir, ".env")}`,
        "-e",
        `process.stdout.write(process.env[${JSON.stringify(name)}] ?? "")`,
      ],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
    );
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      value: read.stdout,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertWritesWithoutPrinting(command: string, name: string): void {
  const first = runInCopy(command, name);
  assert.deepEqual(
    { status: first.status, stdout: first.stdout, stderr: first.stderr },
    { status: 0, stdout: "", stderr: "" },
    `${JSON.stringify(command)} prints nothing`,
  );
  assert.ok(
    first.value.length >= 32,
    `${name} in .env holds at least 32 characters`,
  );
  // A fresh value each run, not a fixed one.
  assert.notEqual(runInCopy(command, name).value, first.value);
}

test("the STATION_DISPLAY_TOKEN commands in .env.example and the start-up error write a new token into .env without printing it", () => {
  const documented = documentedCommand("STATION_DISPLAY_TOKEN");
  assertWritesWithoutPrinting(documented, "STATION_DISPLAY_TOKEN");
  const dir = mkdtempSync(join(tmpdir(), "limen-secret-"));
  try {
    const keyPath = join(dir, "organizer.json");
    writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
    const start = spawnSync(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH ?? "", ORGANIZER_KEYPAIR_PATH: keyPath },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(start.status, 1);
    assert.equal(recommendedCommand(start.stderr), documented);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the REGISTRATION_SALT commands in .env.example and the import error write a new salt into .env without printing it", () => {
  const documented = documentedCommand("REGISTRATION_SALT");
  assertWritesWithoutPrinting(documented, "REGISTRATION_SALT");
  assert.throws(
    () => loadRegistrationSalt(undefined),
    (err: Error) => recommendedCommand(err.message) === documented,
  );
});
