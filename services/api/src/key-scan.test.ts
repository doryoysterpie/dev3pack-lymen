// E-03: the private-key content scan that CI runs over every tracked file (key-scan.ts). Every
// sample is built at run time, so this file holds no key material itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { base58, keyMaterialIn, scanTrackedFiles } from "./key-scan.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("each kind of private-key material is found, in text and in raw bytes", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const keypair = [...randomBytes(64)];
  const cases: [string, Buffer][] = [
    ["pem-private-key", Buffer.from(`const k = \`${pem}\`;\n`)],
    [
      "pem-private-key",
      Buffer.from(`-----BEGIN ${"RSA "}PRIVATE KEY-----\nAAAA\n`),
    ],
    ["pkcs8-der", Buffer.concat([randomBytes(5), der, randomBytes(5)])],
    ["json-64-byte-array", Buffer.from(`${JSON.stringify(keypair)}\n`)],
    ["json-64-byte-array", Buffer.from(`{"key": [${keypair.join(", ")}]}`)],
    ["base58-64-bytes", Buffer.from(`secret: ${base58(randomBytes(64))}\n`)],
  ];
  for (const [reason, bytes] of cases)
    assert.deepEqual(keyMaterialIn(bytes), [reason], reason);
});

test("near misses are not hits: a public key, 63 or 65 numbers, a value over 255, 32 bytes of base58", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const near = [
    publicKey.export({ format: "pem", type: "spki" }).toString(),
    JSON.stringify([...randomBytes(63)]),
    JSON.stringify([...randomBytes(65)]),
    JSON.stringify([256, ...randomBytes(63)]),
    base58(randomBytes(32)),
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
    });
    assert.equal(r.status, 0, `${path} is ignored`);
  }
});
