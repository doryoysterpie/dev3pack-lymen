// Transaction serializer (E-09). Pure module. The inverse of parseTransaction
// in wire.ts, to the same sources: anza-xyz/solana-sdk at commit 7b382f6,
// message/src/versions/mod.rs, message/src/versions/v0/mod.rs,
// message/src/legacy.rs and short-vec/src/lib.rs.

import { decodePublicKey } from "./base58.ts";
import type { ParsedMessage } from "./wire.ts";

const VERSION_PREFIX = 0x80;

/** compact-u16, least significant 7 bits first, as short-vec encodes it. */
function compactU16(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`encode: ${value} does not fit compact-u16`);
  }
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

function key(address: string): Uint8Array {
  const bytes = decodePublicKey(address);
  if (bytes === null) throw new Error(`encode: ${address} is not a key`);
  return bytes;
}

function u8(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`encode: ${value} does not fit a byte`);
  }
  return value;
}

/** The message bytes, which each signature signs. */
export function encodeMessage(message: ParsedMessage): Uint8Array {
  const parts: (number[] | Uint8Array)[] = [];
  const { header } = message;
  if (message.version === 0) parts.push([VERSION_PREFIX]);
  parts.push([
    u8(header.numRequiredSignatures),
    u8(header.numReadonlySignedAccounts),
    u8(header.numReadonlyUnsignedAccounts),
  ]);
  parts.push(compactU16(message.staticKeys.length));
  for (const address of message.staticKeys) parts.push(key(address));
  parts.push(key(message.recentBlockhash));
  parts.push(compactU16(message.instructions.length));
  for (const instruction of message.instructions) {
    parts.push([u8(instruction.programIdIndex)]);
    parts.push(compactU16(instruction.accountIndexes.length));
    parts.push(instruction.accountIndexes.map(u8));
    parts.push(compactU16(instruction.data.length));
    parts.push(instruction.data);
  }
  if (message.version === 0) {
    parts.push(compactU16(message.lookups.length));
    for (const lookup of message.lookups) {
      parts.push(key(lookup.table));
      parts.push(compactU16(lookup.writableIndexes.length));
      parts.push(lookup.writableIndexes.map(u8));
      parts.push(compactU16(lookup.readonlyIndexes.length));
      parts.push(lookup.readonlyIndexes.map(u8));
    }
  } else if (message.lookups.length > 0) {
    throw new Error("encode: a legacy message has no lookup tables");
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A serialized transaction: the signatures, then the message. */
export function encodeTransaction(
  signatures: readonly Uint8Array[],
  message: ParsedMessage,
): Uint8Array {
  const count = compactU16(signatures.length);
  const body = encodeMessage(message);
  const out = new Uint8Array(
    count.length + 64 * signatures.length + body.length,
  );
  out.set(count, 0);
  signatures.forEach((signature, i) => {
    if (signature.length !== 64) {
      throw new Error("encode: a signature is 64 bytes");
    }
    out.set(signature, count.length + 64 * i);
  });
  out.set(body, count.length + 64 * signatures.length);
  return out;
}
