import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTransaction, type WireProblem } from "./wire.ts";

// A raw transaction writer, written from the layout in the SDK sources, so the
// parser's refusals can be tested one rule at a time.
function compact(value: number): number[] {
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

const keyBytes = (n: number) =>
  Array.from({ length: 32 }, (_, i) => (n * 7 + i) & 0xff);

interface Raw {
  signatures?: number;
  version?: number | null;
  header?: [number, number, number];
  keys?: number;
  duplicateKey?: boolean;
  instructions?: { program: number; accounts: number[]; data: number[] }[];
  lookups?: { writable: number[]; readonly: number[] }[];
  trailing?: number[];
}

function raw(spec: Raw): Uint8Array {
  const keys = spec.keys ?? 3;
  const bytes: number[] = [];
  const signatures = spec.signatures ?? 1;
  bytes.push(...compact(signatures));
  for (let i = 0; i < signatures; i += 1) bytes.push(...new Array(64).fill(0));
  if (spec.version !== null && spec.version !== undefined) {
    bytes.push(0x80 | spec.version);
  }
  bytes.push(...(spec.header ?? [1, 0, 1]));
  bytes.push(...compact(keys));
  for (let i = 0; i < keys; i += 1) {
    bytes.push(...keyBytes(spec.duplicateKey && i === keys - 1 ? 0 : i));
  }
  bytes.push(...keyBytes(99)); // recent blockhash
  const instructions = spec.instructions ?? [
    { program: keys - 1, accounts: [0], data: [1, 2, 3] },
  ];
  bytes.push(...compact(instructions.length));
  for (const ix of instructions) {
    bytes.push(ix.program, ...compact(ix.accounts.length), ...ix.accounts);
    bytes.push(...compact(ix.data.length), ...ix.data);
  }
  if (spec.version !== null && spec.version !== undefined) {
    const lookups = spec.lookups ?? [];
    bytes.push(...compact(lookups.length));
    lookups.forEach((lookup, i) => {
      bytes.push(...keyBytes(200 + i));
      bytes.push(...compact(lookup.writable.length), ...lookup.writable);
      bytes.push(...compact(lookup.readonly.length), ...lookup.readonly);
    });
  }
  bytes.push(...(spec.trailing ?? []));
  return new Uint8Array(bytes);
}

function refused(bytes: Uint8Array): WireProblem | "parsed" {
  const result = parseTransaction(bytes);
  return result.ok ? "parsed" : result.problem;
}

describe("wire format", () => {
  it("parses a minimal legacy and a minimal v0 transaction", () => {
    const legacy = parseTransaction(raw({ version: null }));
    assert.ok(legacy.ok);
    assert.equal(legacy.transaction.message.version, "legacy");
    const v0 = parseTransaction(
      raw({ version: 0, lookups: [{ writable: [0], readonly: [1] }] }),
    );
    assert.ok(v0.ok);
    assert.equal(v0.transaction.message.version, 0);
    assert.equal(v0.transaction.message.lookups.length, 1);
  });

  it("finds the recent blockhash at the offset it reports", () => {
    const result = parseTransaction(raw({ version: null }));
    assert.ok(result.ok);
    const { messageBytes, blockhashOffset } = result.transaction;
    assert.deepEqual(
      Array.from(messageBytes.subarray(blockhashOffset, blockhashOffset + 32)),
      keyBytes(99),
    );
  });

  const cases: ReadonlyArray<readonly [string, Uint8Array, WireProblem]> = [
    ["truncated", raw({ version: null }).slice(0, 100), "truncated"],
    [
      "a trailing byte",
      raw({ version: null, trailing: [0] }),
      "trailing-bytes",
    ],
    ["version 1", raw({ version: 1 }), "unsupported-version"],
    [
      "version 127, the off-chain prefix",
      raw({ version: 127 }),
      "unsupported-version",
    ],
    [
      "no signature for a required signer",
      raw({ signatures: 0 }),
      "signature-count",
    ],
    [
      "two signatures for one signer",
      raw({ signatures: 2 }),
      "signature-count",
    ],
    ["no writable signer", raw({ header: [1, 1, 0] }), "bad-header"],
    ["a header past the key list", raw({ header: [2, 0, 2] }), "bad-header"],
    ["the same key twice", raw({ duplicateKey: true }), "duplicate-key"],
    [
      "the fee payer as the program",
      raw({ instructions: [{ program: 0, accounts: [], data: [] }] }),
      "bad-program-index",
    ],
    [
      "a program index past the static keys",
      raw({
        version: 0,
        lookups: [{ writable: [0], readonly: [] }],
        instructions: [{ program: 3, accounts: [], data: [] }],
      }),
      "bad-program-index",
    ],
    [
      "an account index past every key",
      raw({ instructions: [{ program: 2, accounts: [3], data: [] }] }),
      "bad-account-index",
    ],
    [
      "a lookup that loads nothing",
      raw({ version: 0, lookups: [{ writable: [], readonly: [] }] }),
      "empty-lookup",
    ],
    [
      "more than 256 keys",
      raw({
        version: 0,
        keys: 3,
        lookups: [
          { writable: Array.from({ length: 254 }, (_, i) => i), readonly: [] },
        ],
      }),
      "too-many-keys",
    ],
  ];

  for (const [name, bytes, problem] of cases) {
    it(`refuses ${name}`, () => {
      assert.equal(refused(bytes), problem);
    });
  }

  it("accepts exactly 256 keys", () => {
    const bytes = raw({
      version: 0,
      keys: 3,
      lookups: [
        { writable: Array.from({ length: 253 }, (_, i) => i), readonly: [] },
      ],
    });
    assert.equal(refused(bytes), "parsed");
  });

  it("refuses compact-u16 lengths that short-vec refuses", () => {
    // An alias (a zero byte after the first), a third byte that continues, and
    // a value past 0xffff.
    for (const prefix of [
      [0x80, 0x00],
      [0x80, 0x80, 0x80],
      [0xff, 0xff, 0x04],
    ]) {
      assert.equal(refused(new Uint8Array(prefix)), "bad-compact-length");
    }
    // 0xffff itself is a valid length; the bytes then run out.
    assert.equal(refused(new Uint8Array([0xff, 0xff, 0x03])), "truncated");
  });
});
