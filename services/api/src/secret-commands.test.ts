// Rule 8: the command the docs give for making a secret must not print it. Every secret
// .env.example documents (each variable whose comment asks for at least 32 characters), and every
// mention of `openssl rand` in .env.example or in any README, must be the one command form that
// appends the value to .env and prints nothing. Each such line runs here whole, with its comment
// marker and indentation removed, in a copy of the repository's .env.example, and owes that it
// prints nothing and leaves a fresh value of at least 32 characters that Node reads from .env.
// For STATION_DISPLAY_TOKEN and REGISTRATION_SALT the command their errors recommend must be the
// documented one.
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

/** A documented line as a command: the whole line without its comment marker and indentation. */
function lineCommand(line: string): string {
  return line.replace(/^#?\s*/, "").trimEnd();
}

/** The command .env.example documents for `name`: the whole comment line just above `name=`. */
function documentedCommand(name: string): string {
  const lines = EXAMPLE.split("\n");
  const at = lines.indexOf(`${name}=`);
  assert.ok(at > 0, `.env.example has a ${name}= line`);
  const comment = lines[at - 1]!;
  assert.match(comment, /^#/, `a comment sits above ${name}=`);
  return lineCommand(comment);
}

/** The command a diagnostic recommends: the text after its last ": ". */
function recommendedCommand(message: string): string {
  return message.slice(message.lastIndexOf(": ") + 2).trim();
}

/** Runs `command` with sh in a copy of .env.example; returns its output and what Node then reads. */
function runInCopy(command: string, name: string, trace = false) {
  const dir = mkdtempSync(join(tmpdir(), "limen-secret-"));
  try {
    writeFileSync(join(dir, ".env"), EXAMPLE);
    const run = spawnSync("sh", [...(trace ? ["-x"] : []), "-c", command], {
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
  // Under sh -x the shell traces each command with its arguments: the secret is in none of them.
  const traced = runInCopy(command, name, true);
  assert.equal(traced.status, 0);
  assert.ok(traced.value.length >= 32);
  assert.ok(
    !traced.stderr.includes(traced.value),
    `${JSON.stringify(command)} puts the secret in a command's arguments`,
  );
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

// The one command form that writes a secret without printing it, for the variable it names. It
// must be the whole command: nothing may come before or after it on its line.
// A blank line, then NAME= and the generator's output, piped so the secret is in no argument.
const WRITE_COMMAND =
  /^\{ echo; openssl rand -base64 32 \| sed 's\/\^\/([A-Z][A-Z0-9_]*)=\/'; \} >> \.env$/;
const MAKES_A_SECRET = /openssl\s+rand/;

/**
 * Checks one documented line that makes a secret: the whole line, without its comment marker and
 * indentation, must be the write command, and the whole line is what runs.
 */
function assertSecretLine(line: string, where: string): void {
  const command = lineCommand(line);
  const match = WRITE_COMMAND.exec(command);
  assert.ok(
    match,
    `${where}: ${JSON.stringify(line)} is not the write command alone`,
  );
  assertWritesWithoutPrinting(command, match[1]!);
}

test("a documented secret line runs whole: a write command with more on its line is refused", () => {
  const write = `{ echo; openssl rand -base64 32 | sed 's/^/X_TOKEN=/'; } >> .env`;
  for (const line of [write, `#   ${write}`])
    assert.doesNotThrow(() => assertSecretLine(line, "test"), line);
  for (const line of [
    `${write}; cat .env`,
    `#   ${write} && cat .env`,
    `echo "$(openssl rand -base64 32)"; ${write}`,
    `Run ${write} from the repository root.`,
  ])
    assert.throws(() => assertSecretLine(line, "test"), line);
});

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
    const lines = comment.filter((c) => MAKES_A_SECRET.test(c));
    assert.deepEqual(
      lines.map((c) => WRITE_COMMAND.exec(lineCommand(c))?.[1]),
      [name],
      `the comment above ${name}= gives one command, and it writes ${name}`,
    );
    assertSecretLine(lines[0]!, `.env.example, ${name}`);
  }
});

test("every openssl rand line in .env.example is a command that writes its secret without printing it", () => {
  for (const line of EXAMPLE.split("\n")) {
    if (MAKES_A_SECRET.test(line)) assertSecretLine(line, ".env.example");
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
        if (MAKES_A_SECRET.test(line))
          assertSecretLine(line, `${relative(ROOT, file)}:${i + 1}`);
      });
  }
});
