// Finds private-key material by content (E-03), and flags what the organizer-key loader accepts
// as a key: every bracketed array, and every base58 run decoded to bytes, is given to the loader's
// own acceptsAsKeypair, with no length or form filter first. It also flags PEM private-key headers
// and Ed25519 PKCS#8 DER in raw bytes. A tracked file it cannot read, or that is not a regular
// file, fails the scan. CI runs it over every tracked file (key-scan.test.ts):
//
//   node services/api/src/key-scan.ts
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "./main-module.ts";
import { acceptsAsKeypair } from "./organizer-key.ts";

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
/** Ed25519 PKCS#8 DER, versions 1 and 2: the version, the algorithm, and the key's wrapper. */
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

/** The kinds of private-key material in `bytes`, each named once. */
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

/** Scans every file git tracks under `root`; one it cannot read, or not a regular file, is a hit. */
export function scanTrackedFiles(root: string): {
  files: number;
  hits: { file: string; reasons: string[] }[];
} {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  const names = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  const hits: { file: string; reasons: string[] }[] = [];
  for (const file of names) {
    const path = join(root, file);
    let reasons: string[];
    try {
      reasons = lstatSync(path).isFile()
        ? keyMaterialIn(readFileSync(path))
        : ["not-a-regular-file"];
    } catch {
      reasons = ["unreadable"];
    }
    if (reasons.length > 0) hits.push({ file, reasons });
  }
  return { files: names.length, hits };
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
