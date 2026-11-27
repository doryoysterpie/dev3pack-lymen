// Transaction wire format parser (E-09, audited). Pure module.
//
// Layout and sanitize rules follow anza-xyz/solana-sdk at commit 7b382f6:
// message/src/versions/mod.rs (version prefix 0x80), message/src/versions/v0/
// mod.rs (v0 layout and sanitize), message/src/legacy.rs, and
// short-vec/src/lib.rs (compact-u16). Anything outside those rules is refused
// with a reason, never guessed at.

import { encodeBase58 } from "./base58.ts";

export interface MessageHeader {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
}

export interface CompiledInstruction {
  readonly programIdIndex: number;
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
}

export interface LookupReference {
  readonly table: string;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

export interface ParsedMessage {
  readonly version: "legacy" | 0;
  readonly header: MessageHeader;
  readonly staticKeys: readonly string[];
  readonly recentBlockhash: string;
  readonly instructions: readonly CompiledInstruction[];
  readonly lookups: readonly LookupReference[];
}

export interface ParsedTransaction {
  readonly signatures: readonly Uint8Array[];
  readonly message: ParsedMessage;
  /** The serialized message, the bytes each signature signs. */
  readonly messageBytes: Uint8Array;
  /** Where the recent blockhash starts inside messageBytes. */
  readonly blockhashOffset: number;
}

export type WireProblem =
  | "truncated"
  | "bad-compact-length"
  | "trailing-bytes"
  | "unsupported-version"
  | "signature-count"
  | "bad-header"
  | "duplicate-key"
  | "too-many-keys"
  | "empty-lookup"
  | "bad-program-index"
  | "bad-account-index";

export type ParseResult =
  | { readonly ok: true; readonly transaction: ParsedTransaction }
  | { readonly ok: false; readonly problem: WireProblem };

const VERSION_PREFIX = 0x80;
const SIGNATURE_LENGTH = 64;
const KEY_LENGTH = 32;
const MAX_ACCOUNT_KEYS = 256;

class Refused extends Error {
  readonly problem: WireProblem;
  constructor(problem: WireProblem) {
    super(problem);
    this.problem = problem;
  }
}

interface Reader {
  readonly bytes: Uint8Array;
  offset: number;
}

function take(reader: Reader, length: number): Uint8Array {
  if (reader.offset + length > reader.bytes.length) {
    throw new Refused("truncated");
  }
  const slice = reader.bytes.subarray(reader.offset, reader.offset + length);
  reader.offset += length;
  return slice;
}

function readU8(reader: Reader): number {
  return take(reader, 1)[0];
}

/**
 * compact-u16, as short-vec decodes it: at most 3 bytes, 7 bits each, least
 * significant first. A zero byte after the first is an alias, the third byte
 * may not continue, and the value may not pass 0xffff.
 */
function readCompactU16(reader: Reader): number {
  let value = 0;
  for (let n = 0; n < 3; n += 1) {
    const byte = readU8(reader);
    if (byte === 0 && n !== 0) throw new Refused("bad-compact-length");
    if (n === 2 && (byte & 0x80) !== 0) {
      throw new Refused("bad-compact-length");
    }
    value += (byte & 0x7f) * 2 ** (7 * n);
    if (value > 0xffff) throw new Refused("bad-compact-length");
    if ((byte & 0x80) === 0) return value;
  }
  throw new Refused("bad-compact-length");
}

function readKey(reader: Reader): string {
  return encodeBase58(take(reader, KEY_LENGTH));
}

function readIndexList(reader: Reader): number[] {
  const count = readCompactU16(reader);
  return Array.from(take(reader, count));
}

function readMessage(reader: Reader): {
  message: ParsedMessage;
  blockhashOffset: number;
} {
  const start = reader.offset;
  const first = readU8(reader);
  let version: "legacy" | 0;
  let numRequiredSignatures: number;
  if ((first & VERSION_PREFIX) !== 0) {
    // Versioned message. Only version 0 is accepted here; version 1 and the
    // off-chain prefix (127) are refused.
    if ((first & ~VERSION_PREFIX) !== 0) {
      throw new Refused("unsupported-version");
    }
    version = 0;
    numRequiredSignatures = readU8(reader);
  } else {
    version = "legacy";
    numRequiredSignatures = first;
  }
  const header: MessageHeader = {
    numRequiredSignatures,
    numReadonlySignedAccounts: readU8(reader),
    numReadonlyUnsignedAccounts: readU8(reader),
  };

  const keyCount = readCompactU16(reader);
  const staticKeys: string[] = [];
  for (let i = 0; i < keyCount; i += 1) staticKeys.push(readKey(reader));

  const blockhashOffset = reader.offset - start;
  const recentBlockhash = readKey(reader);

  const instructionCount = readCompactU16(reader);
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < instructionCount; i += 1) {
    const programIdIndex = readU8(reader);
    const accountIndexes = readIndexList(reader);
    const dataLength = readCompactU16(reader);
    // Copy, so the instruction does not alias the caller's buffer.
    const data = take(reader, dataLength).slice();
    instructions.push({ programIdIndex, accountIndexes, data });
  }

  const lookups: LookupReference[] = [];
  if (version === 0) {
    const lookupCount = readCompactU16(reader);
    for (let i = 0; i < lookupCount; i += 1) {
      const table = readKey(reader);
      const writableIndexes = readIndexList(reader);
      const readonlyIndexes = readIndexList(reader);
      lookups.push({ table, writableIndexes, readonlyIndexes });
    }
  }

  return {
    message: {
      version,
      header,
      staticKeys,
      recentBlockhash,
      instructions,
      lookups,
    },
    blockhashOffset,
  };
}

/** The sanitize rules of v0 Message::sanitize, applied to both versions. */
function sanitize(message: ParsedMessage, signatureCount: number): void {
  const { header, staticKeys, instructions, lookups } = message;
  if (
    header.numRequiredSignatures + header.numReadonlyUnsignedAccounts >
    staticKeys.length
  ) {
    throw new Refused("bad-header");
  }
  // There must be at least one writable signer, the fee payer.
  if (header.numReadonlySignedAccounts >= header.numRequiredSignatures) {
    throw new Refused("bad-header");
  }
  // One signature per required signer.
  if (signatureCount !== header.numRequiredSignatures) {
    throw new Refused("signature-count");
  }
  // The runtime refuses a transaction that loads an account twice.
  if (new Set(staticKeys).size !== staticKeys.length) {
    throw new Refused("duplicate-key");
  }

  let lookupKeyCount = 0;
  for (const lookup of lookups) {
    const count = lookup.writableIndexes.length + lookup.readonlyIndexes.length;
    if (count === 0) throw new Refused("empty-lookup");
    lookupKeyCount += count;
  }
  const totalKeys = staticKeys.length + lookupKeyCount;
  if (totalKeys > MAX_ACCOUNT_KEYS) throw new Refused("too-many-keys");

  for (const instruction of instructions) {
    // Program ids come from the static keys only, and the fee payer at index
    // 0 cannot be a program.
    if (
      instruction.programIdIndex === 0 ||
      instruction.programIdIndex >= staticKeys.length
    ) {
      throw new Refused("bad-program-index");
    }
    for (const index of instruction.accountIndexes) {
      if (index >= totalKeys) throw new Refused("bad-account-index");
    }
  }
}

/** Parses a serialized transaction: signatures, then the message. */
export function parseTransaction(bytes: Uint8Array): ParseResult {
  const reader: Reader = { bytes, offset: 0 };
  try {
    const signatureCount = readCompactU16(reader);
    const signatures: Uint8Array[] = [];
    for (let i = 0; i < signatureCount; i += 1) {
      signatures.push(take(reader, SIGNATURE_LENGTH).slice());
    }
    const messageStart = reader.offset;
    const { message, blockhashOffset } = readMessage(reader);
    if (reader.offset !== bytes.length) throw new Refused("trailing-bytes");
    sanitize(message, signatureCount);
    return {
      ok: true,
      transaction: {
        signatures,
        message,
        messageBytes: bytes.slice(messageStart),
        blockhashOffset,
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.problem };
    throw error;
  }
}
