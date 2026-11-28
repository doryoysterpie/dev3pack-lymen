// E-03: the private-key content scan that CI runs over every tracked file (key-scan.ts). Every
// sample is built at run time, so this file holds no key material itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { base58, keyMaterialIn, scanTrackedFiles } from "./key-scan.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** An Ed25519 key in PKCS#8 version 2: version 1, the seed, then the public key in [1]. */
function pkcs8v2(): Buffer {
  const pair = solanaKeypair();
  return Buffer.concat([
    Buffer.from("3053020101300506032b657004220420", "hex"),
    pair.subarray(0, 32),
    Buffer.from("a123032100", "hex"),
    pair.subarray(32),
  ]);
}

/** A real Solana-style keypair: the 32-byte Ed25519 seed, then its own public key. */
function solanaKeypair(): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey
    .export({ format: "der", type: "pkcs8" })
    .subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Buffer.concat([seed, pub]);
}

test("each kind of private-key material is found, in text and in raw bytes", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const keypair = [...solanaKeypair()];
  const cases: [string, Buffer][] = [
    ["pem-private-key", Buffer.from(`const k = \`${pem}\`;\n`)],
    [
      "pem-private-key",
      Buffer.from(`-----BEGIN ${"RSA "}PRIVATE KEY-----\nAAAA\n`),
    ],
    ["pkcs8-der", Buffer.concat([randomBytes(5), der, randomBytes(5)])],
    ["json-keypair", Buffer.from(`${JSON.stringify(keypair)}\n`)],
    ["json-keypair", Buffer.from(`{"key": [${keypair.join(", ")}]}`)],
    ["base58-keypair", Buffer.from(`secret: ${base58(solanaKeypair())}\n`)],
    // As Prettier writes an array in TypeScript: one value a line, with a trailing comma.
    [
      "json-keypair",
      Buffer.from(
        `const key = new Uint8Array([\n${[...solanaKeypair()].map((n) => `  ${n},\n`).join("")}]);\n`,
      ),
    ],
    // PKCS#8 version 2 (RFC 8410's OneAsymmetricKey), which also carries the public key.
    ["pkcs8-der", pkcs8v2()],
  ];
  for (const [reason, bytes] of cases)
    assert.deepEqual(keyMaterialIn(bytes), [reason], reason);
});

test("near misses are not hits: a public key, a real signature and random 64 bytes, 63 or 65 numbers, a value over 255, 32 bytes of base58", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // A real Ed25519 signature, 64 bytes, as a Solana transaction carries one.
  const signature = sign(
    null,
    Buffer.from("a transaction message"),
    privateKey,
  );
  const near = [
    publicKey.export({ format: "pem", type: "spki" }).toString(),
    JSON.stringify([...randomBytes(63)]),
    JSON.stringify([...randomBytes(65)]),
    JSON.stringify([256, ...randomBytes(63)]),
    base58(randomBytes(32)),
    base58(signature),
    JSON.stringify([...signature]),
    base58(randomBytes(64)),
    JSON.stringify([...randomBytes(64)]),
    "the words BEGIN and PRIVATE KEY apart",
  ];
  for (const text of near)
    assert.deepEqual(keyMaterialIn(Buffer.from(text)), [], text.slice(0, 40));
});

test("no tracked file holds private-key material", () => {
  const { files, hits } = scanTrackedFiles(ROOT);
  assert.ok(files > 50, `${files} tracked files scanned`);
  assert.deepEqual(hits, []);
});

test("CI runs the scan, and git ignores .der, .pem, .key and .p12 files anywhere", () => {
  const ci = readFileSync(
    new URL("../../../.github/workflows/lint.yml", import.meta.url),
    "utf8",
  );
  assert.match(ci, /\n {8}run: node services\/api\/src\/key-scan\.ts\n/);
  for (const path of [
    "a.der",
    "apps/station/src/organizer.der",
    "x/y.pem",
    "k.key",
    "services/api/c.p12",
  ]) {
    const r = spawnSync("git", ["check-ignore", "-q", "--no-index", path], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(r.status, 0, `${path} is ignored`);
  }
});

test("the CI step label and README state exactly what the key scan covers and does not cover", () => {
  const ci = readFileSync(
    new URL("../../../.github/workflows/lint.yml", import.meta.url),
    "utf8",
  );
  const step =
    /\n {6}- name: ([^\n]+)\n {8}run: node services\/api\/src\/key-scan\.ts\n/.exec(
      ci,
    )?.[1];
  assert.ok(step !== undefined, "CI step label is present");
  assert.match(step, /tracked files/i);
  assert.match(step, /PEM/i);
  assert.match(step, /Ed25519 PKCS#8 DER/i);
  assert.match(step, /Solana Ed25519 keypairs/i);

  const readme = readFileSync(
    new URL("../../../README.md", import.meta.url),
    "utf8",
  );
  assert.match(readme, /untracked files or git history/i);
  assert.match(readme, /non-key secrets/i);
  assert.match(readme, /PEM private-key headers/i);
  assert.match(readme, /Ed25519 PKCS#8 DER/i);
});

test("the scan flags exactly what the organizer-key loader accepts: every number form JSON allows, and base58 of any length", async () => {
  const { acceptsAsKeypair } = await import("./organizer-key.ts");
  const pair = solanaKeypair();
  const forms = [
    JSON.stringify([...pair]),
    `[${[...pair].map((n) => `${n}.0`).join(",")}]`,
    `[${[...pair].map((n) => (n === 0 ? "-0" : `${n}e0`)).join(", ")}]`,
    `[\n${[...pair].map((n) => `  ${n}`).join(",\n")}\n]`,
  ];
  const near = [
    JSON.stringify([...pair].slice(0, 63)),
    JSON.stringify([...pair, 0]),
    JSON.stringify([...pair.subarray(0, 32), ...randomBytes(32)]),
    JSON.stringify([256, ...pair.subarray(1)]),
    `[${[...pair].map((n) => `${n}.5`).join(",")}]`,
  ];
  for (const text of [...forms, ...near]) {
    const hit = keyMaterialIn(Buffer.from(`const k = ${text};\n`)).includes(
      "json-keypair",
    );
    assert.equal(hit, acceptsAsKeypair(text), text.slice(0, 40));
  }
  for (const text of forms)
    assert.ok(acceptsAsKeypair(text), "the loader accepts");
  // A seed starting with 25 zero bytes encodes in fewer than 80 base58 characters.
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const seed = Buffer.concat([Buffer.alloc(25), randomBytes(7)]);
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const short = base58(Buffer.concat([seed, pub]));
  assert.ok(short.length < 80, `${short.length} characters`);
  assert.deepEqual(keyMaterialIn(Buffer.from(`k=${short}\n`)), [
    "base58-keypair",
  ]);
});

test("a tracked symlink, or a tracked file missing from the tree, fails the scan rather than being skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-key-scan-"));
  try {
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
    git("init", "-q");
    writeFileSync(join(dir, "kept.txt"), "fine\n");
    writeFileSync(join(dir, "gone.txt"), "soon gone\n");
    symlinkSync("kept.txt", join(dir, "link.txt"));
    git("add", "kept.txt", "gone.txt", "link.txt");
    rmSync(join(dir, "gone.txt"));
    const { hits } = scanTrackedFiles(dir);
    assert.deepEqual(hits.map((h) => [h.file, h.reasons]).sort(), [
      ["gone.txt", ["unreadable"]],
      ["link.txt", ["not-a-regular-file"]],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the key scan is documented as node services/api/src/key-scan.ts, not an npm script, and under NODE_DEBUG=child_process prints neither an exported secret nor any spawn option holding it", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const documented = /`([^`\n]*key-scan\.ts[^`\n]*)`/.exec(readme)?.[1]?.trim();
  assert.ok(
    documented !== undefined,
    "README.md documents the key-scan command",
  );

  const secret = "key-scan-shell-secret-0123456789abcdef";
  const rpcSecret =
    "https://rpc.devnet.example/?api-key=scan-rpc-secret-987654";
  for (const debug of ["child_process", "*"]) {
    const command: string = documented;
    const r = spawnSync("sh", ["-c", command], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        STATION_DISPLAY_TOKEN: secret,
        SOLANA_RPC_URL: rpcSecret,
        NODE_DEBUG: debug,
      },
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr.slice(-600));
    assert.match(
      r.stderr,
      /CHILD_PROCESS/,
      `NODE_DEBUG=${debug} traced child spawn`,
    );
    const combined = r.stdout + r.stderr;
    for (const forbidden of [
      secret,
      rpcSecret,
      "STATION_DISPLAY_TOKEN",
      "SOLANA_RPC_URL",
    ]) {
      assert.ok(
        !combined.includes(forbidden),
        `NODE_DEBUG=${debug} leaked ${forbidden.startsWith("http") || forbidden.includes("secret") ? "secret value" : forbidden} in output`,
      );
    }
  }

  assert.equal(documented, "node services/api/src/key-scan.ts");
  for (const rel of [
    "package.json",
    "apps/station/package.json",
    "services/api/package.json",
  ]) {
    const manifest = JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(manifest.scripts ?? {})) {
      assert.ok(
        !cmd.includes("key-scan"),
        `${rel} script ${name} invokes key-scan`,
      );
    }
  }
});
