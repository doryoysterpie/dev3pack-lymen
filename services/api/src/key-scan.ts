// Scans regular tracked files for private-key patterns (E-03): every bracketed array, and every
// base58 run decoded to bytes, is given to the organizer-key loader's acceptsAsKeypair, alongside
// PEM private-key header lines and the two 14-byte Ed25519 PKCS#8 DER (v1/v2) header sequences.
// Any tracked path that cannot be read or is not a regular file is not scanned and fails the run
// (key-scan.test.ts):
//
//   node services/api/src/key-scan.ts
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "./main-module.ts";
import { acceptsAsKeypair } from "./organizer-key.ts";

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
/** 14-byte Ed25519 PKCS#8 DER header sequences (v1 and v2): version, OID 1.3.101.112, and 04 22 04 20; matched alone without outer SEQUENCE or trailing seed bytes. */
const DER_PREFIXES = [
  "020100300506032b657004220420",
  "020101300506032b657004220420",
].map((hex) => Buffer.from(hex, "hex"));
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;

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

/** The bytes base58 `text` decodes to. */
function fromBase58(text: string): Buffer {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const zeros = text.length - text.replace(/^1+/, "").length;
  const hex = n === 0n ? "" : n.toString(16);
  return Buffer.concat([
    Buffer.alloc(zeros),
    Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex"),
  ]);
}

/** Every bracketed span from each "[" to its matching "]", by depth alone. */
function bracketSpans(text: string): string[] {
  const spans: string[] = [];
  for (let i = text.indexOf("["); i !== -1; i = text.indexOf("[", i + 1)) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "[") depth++;
      else if (text[j] === "]" && --depth === 0) {
        spans.push(text.slice(i, j + 1));
        break;
      }
    }
  }
  return spans;
}

/** The key-scan pattern names matched in `bytes`, each named once. */
export function keyMaterialIn(bytes: Buffer): string[] {
  const text = bytes.toString("latin1");
  const found = new Set<string>();
  if (PEM.test(text)) found.add("pem-private-key");
  if (DER_PREFIXES.some((prefix) => bytes.includes(prefix)))
    found.add("pkcs8-der");
  // As written, and as Prettier writes an array in TypeScript, with a trailing comma.
  for (const span of bracketSpans(text))
    if (
      acceptsAsKeypair(span) ||
      acceptsAsKeypair(span.replace(/,\s*\]$/, "]"))
    )
      found.add("json-keypair");
  for (const m of text.matchAll(BASE58_RUN))
    if (acceptsAsKeypair(JSON.stringify([...fromBase58(m[0])])))
      found.add("base58-keypair");
  return [...found];
}

/** Checks every path git tracks under `root`; unreadable or non-regular paths are not scanned and are recorded in `hits`. */
export function scanTrackedFiles(root: string): {
  files: number;
  scanned: number;
  hits: { file: string; reasons: string[] }[];
} {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
  });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  const names = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  const hits: { file: string; reasons: string[] }[] = [];
  let scanned = 0;
  for (const file of names) {
    const path = join(root, file);
    let reasons: string[];
    try {
      if (lstatSync(path).isFile()) {
        const bytes = readFileSync(path);
        scanned++;
        reasons = keyMaterialIn(bytes);
      } else {
        reasons = ["not-a-regular-file"];
      }
    } catch {
      reasons = ["unreadable"];
    }
    if (reasons.length > 0) hits.push({ file, reasons });
  }
  return { files: names.length, scanned, hits };
}

if (isMainModule(import.meta.url)) {
  const { files, scanned, hits } = scanTrackedFiles(process.cwd());
  for (const { file, reasons } of hits)
    console.error(`key-scan: ${file}: ${reasons.join(", ")}`);
  const unscanned = files - scanned;
  const matched = hits.length - unscanned;
  console.log(
    `key-scan: ${scanned} of ${files} tracked paths scanned, ${matched} with key-scan pattern matches, ${unscanned} unreadable or non-regular.`,
  );
  if (hits.length > 0) process.exitCode = 1;
}
