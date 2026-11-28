// Finds private-key material by content (E-03): PEM private-key headers, PKCS#8 DER prefixes in
// raw bytes, JSON arrays of 64 byte values, and base58 strings that decode to 64 bytes. CI runs it
// over every tracked file, and any hit fails the run (key-scan.test.ts):
//
//   node services/api/src/key-scan.ts
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "./main-module.ts";

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
/** PKCS#8 DER: an Ed25519 key's prefix, and the version and algorithm of RSA and EC keys. */
const DER_PREFIXES = [
  "302e020100300506032b657004220420",
  "020100300d06092a864886f70d0101010500",
  "020100301306072a8648ce3d0201",
].map((hex) => Buffer.from(hex, "hex"));
const JSON_64 = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RUN =
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/g;

/** Base58 (Bitcoin alphabet) of `bytes`. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** How many bytes base58 `text` decodes to. */
function base58Length(text: string): number {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return zeros + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2));
}

/** The kinds of private-key material in `bytes`, each named once. */
export function keyMaterialIn(bytes: Buffer): string[] {
  const text = bytes.toString("latin1");
  const found = new Set<string>();
  if (PEM.test(text)) found.add("pem-private-key");
  if (DER_PREFIXES.some((prefix) => bytes.includes(prefix)))
    found.add("pkcs8-der");
  for (const m of text.matchAll(JSON_64))
    if (
      m[0]
        .slice(1, -1)
        .split(",")
        .every((n) => Number(n) <= 255)
    )
      found.add("json-64-byte-array");
  for (const m of text.matchAll(BASE58_RUN))
    if (base58Length(m[0]) === 64) found.add("base58-64-bytes");
  return [...found];
}

/** Scans every file git tracks under `root`, symlinks excepted. */
export function scanTrackedFiles(root: string): {
  files: number;
  hits: { file: string; reasons: string[] }[];
} {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  const names = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  const hits: { file: string; reasons: string[] }[] = [];
  let files = 0;
  for (const file of names) {
    const path = join(root, file);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files++;
    const reasons = keyMaterialIn(readFileSync(path));
    if (reasons.length > 0) hits.push({ file, reasons });
  }
  return { files, hits };
}

if (isMainModule(import.meta.url)) {
  const { files, hits } = scanTrackedFiles(process.cwd());
  for (const { file, reasons } of hits)
    console.error(`key-scan: ${file}: ${reasons.join(", ")}`);
  console.log(
    `key-scan: ${files} tracked files scanned, ${hits.length} with private-key material.`,
  );
  if (hits.length > 0) process.exitCode = 1;
}
