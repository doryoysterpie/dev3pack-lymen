// Rule 8: the command the docs give for making a secret must not print it. Every secret
// .env.example documents (each variable whose comment asks for at least 32 characters), and every
// mention of `openssl rand` in .env.example or in any README, must be the one command form that
// appends the value to .env and prints nothing. Each such command runs here, in a copy of the
// repository's .env.example, and owes that it prints nothing and leaves a fresh value of at least
// 32 characters that Node reads from .env. For STATION_DISPLAY_TOKEN and REGISTRATION_SALT the
// command their errors recommend must be the documented one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

// The one command form that writes a secret without printing it, for the variable it names.
const WRITE_COMMAND =
  /printf '\\n([A-Z][A-Z0-9_]*)=%s\\n' "\$\(openssl rand -base64 32\)" >> \.env/;
const MAKES_A_SECRET = /openssl\s+rand/;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The secrets .env.example documents: each NAME= whose comment block asks for 32 characters. */
function documentedSecrets(): { name: string; comment: string[] }[] {
  const lines = EXAMPLE.split("\n");
  const found: { name: string; comment: string[] }[] = [];
  lines.forEach((line, i) => {
    const match = /^([A-Z][A-Z0-9_]*)=$/.exec(line);
    if (match === null) return;
    const comment: string[] = [];
    for (let j = i - 1; j >= 0 && lines[j]!.startsWith("#"); j--) {
      comment.unshift(lines[j]!);
    }
    if (comment.some((c) => /at least 32 characters/.test(c))) {
      found.push({ name: match[1]!, comment });
    }
  });
  return found;
}

/** Every README.md in the repository, outside dependencies and build output. */
function readmes(dir: string = ROOT): string[] {
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "android",
    "ios",
  ]);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skip.has(entry.name) ? [] : readmes(join(dir, entry.name));
    }
    return entry.name === "README.md" ? [join(dir, entry.name)] : [];
  });
}

test("every secret .env.example documents comes with a command that writes it into .env without printing it", () => {
  const secrets = documentedSecrets();
  assert.deepEqual(
    secrets.map((s) => s.name),
    ["REGISTRATION_SALT", "STATION_DISPLAY_TOKEN", "TRIAGE_TOKEN"],
  );
  for (const { name, comment } of secrets) {
    const commands = comment
      .map((c) => WRITE_COMMAND.exec(c))
      .filter((m) => m !== null);
    assert.deepEqual(
      commands.map((m) => m[1]),
      [name],
      `the comment above ${name}= gives one command that writes ${name}`,
    );
    for (const c of comment) {
      if (MAKES_A_SECRET.test(c)) {
        assert.match(c, WRITE_COMMAND, `${name}: ${JSON.stringify(c)}`);
      }
    }
    assertWritesWithoutPrinting(commands[0]![0], name);
  }
});

test("every openssl rand line in .env.example is a command that writes its secret without printing it", () => {
  for (const line of EXAMPLE.split("\n")) {
    if (!MAKES_A_SECRET.test(line)) continue;
    const command = WRITE_COMMAND.exec(line);
    assert.ok(command, `.env.example: ${JSON.stringify(line)}`);
    assertWritesWithoutPrinting(command[0], command[1]!);
  }
});

test("every secret command in a README writes into .env without printing", () => {
  const files = readmes();
  assert.ok(
    files.some(
      (f) => relative(ROOT, f) === join("services", "api", "README.md"),
    ),
  );
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!MAKES_A_SECRET.test(line)) return;
        const where = `${relative(ROOT, file)}:${i + 1}`;
        const command = WRITE_COMMAND.exec(line);
        assert.ok(command, `${where} gives a command that prints its secret`);
        assertWritesWithoutPrinting(command[0], command[1]!);
      });
  }
});
