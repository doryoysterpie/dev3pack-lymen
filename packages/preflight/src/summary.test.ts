import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as web3 from "@solana/web3.js";

import { decodeBase64 } from "./base64.ts";
import { summarizeTransaction } from "./summary.ts";
import { parseTransaction, type ParsedTransaction } from "./wire.ts";

interface FixtureCase {
  readonly name: string;
  readonly transaction: string;
  readonly tables: Readonly<Record<string, readonly string[]>>;
  readonly owed: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as { readonly user: string; readonly cases: readonly FixtureCase[] };

function parsed(base64: string): ParsedTransaction {
  const bytes = decodeBase64(base64);
  assert.ok(bytes !== null, "fixture is not base64");
  const result = parseTransaction(bytes);
  assert.ok(result.ok, `fixture does not parse: ${JSON.stringify(result)}`);
  return result.transaction;
}

function caseNamed(start: string): FixtureCase {
  const found = fixture.cases.find((c) => c.name.startsWith(start));
  assert.ok(found, `no fixture case starts with ${start}`);
  return found;
}

describe("E-09 done test: fixture transactions yield the owed summary", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const tables = new Map(Object.entries(c.tables));
      const summary = summarizeTransaction(parsed(c.transaction), tables);
      assert.deepEqual(summary, c.owed);
    });
  }

  it("the drainer shows its priority fee, balance out and a delegate approved", () => {
    const c = caseNamed("drainer: SOL balance out");
    const summary = summarizeTransaction(parsed(c.transaction), new Map());
    assert.deepEqual(
      summary.effects.map((effect) => effect.kind),
      ["priority-fee", "sol-out", "delegate-approved"],
    );
    assert.equal(summary.undecoded.length, 0);
  });

  it("an unknown program is listed as undecoded, not a crash", () => {
    const c = caseNamed("unknown program");
    const summary = summarizeTransaction(parsed(c.transaction), new Map());
    assert.deepEqual(
      summary.undecoded.map((entry) => entry.reason),
      ["unknown-program"],
    );
  });
});

describe("damaged transactions", () => {
  // A small deterministic generator, so a failure can be replayed.
  let state = 0x2545f491;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const fixtureBytes = fixture.cases.map((c) => {
    const bytes = decodeBase64(c.transaction);
    assert.ok(bytes !== null);
    return bytes;
  });

  // A well-formed transaction cut short always runs out of bytes, so every
  // strict prefix owes exactly "truncated".
  it("refuses every strict prefix of every fixture as truncated", () => {
    let prefixes = 0;
    for (const bytes of fixtureBytes) {
      for (let length = 0; length < bytes.length; length += 1) {
        assert.deepEqual(parseTransaction(bytes.slice(0, length)), {
          ok: false,
          problem: "truncated",
        });
        prefixes += 1;
      }
    }
    assert.ok(prefixes > 1000);
  });

  // web3.js 1.99.0 is the oracle: a damaged copy limen accepts must read
  // exactly as web3.js reads it.
  it("reads a damaged copy it accepts exactly as web3.js does", () => {
    let accepted = 0;
    for (let round = 0; round < 3000; round += 1) {
      const damaged = fixtureBytes[round % fixtureBytes.length].slice();
      for (let flips = 1 + Math.floor(next() * 4); flips > 0; flips -= 1) {
        damaged[Math.floor(next() * damaged.length)] = Math.floor(next() * 256);
      }
      const result = parseTransaction(damaged);
      if (!result.ok) continue;
      accepted += 1;
      const theirs = web3.VersionedTransaction.deserialize(damaged).message;
      const ours = result.transaction.message;
      assert.deepEqual(
        {
          version: ours.version,
          header: ours.header,
          staticKeys: ours.staticKeys,
          recentBlockhash: ours.recentBlockhash,
          instructions: ours.instructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accountIndexes: [...ix.accountIndexes],
            data: [...ix.data],
          })),
          lookups: ours.lookups.map((lookup) => ({
            table: lookup.table,
            writableIndexes: [...lookup.writableIndexes],
            readonlyIndexes: [...lookup.readonlyIndexes],
          })),
        },
        {
          version: theirs.version,
          header: { ...theirs.header },
          staticKeys: theirs.staticAccountKeys.map((k) => k.toBase58()),
          recentBlockhash: theirs.recentBlockhash,
          instructions: theirs.compiledInstructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accountIndexes: [...ix.accountKeyIndexes],
            data: [...ix.data],
          })),
          lookups: theirs.addressTableLookups.map((lookup) => ({
            table: lookup.accountKey.toBase58(),
            writableIndexes: [...lookup.writableIndexes],
            readonlyIndexes: [...lookup.readonlyIndexes],
          })),
        },
      );
    }
    assert.ok(accepted > 100, `only ${accepted} damaged copies parsed`);
  });

  // Crash coverage only, not a done test: it owes no answer beyond "no throw".
  it("throws on none of 20000 damaged or random inputs, summary included", () => {
    for (let round = 0; round < 20000; round += 1) {
      const c = fixture.cases[round % fixture.cases.length];
      const bytes = fixtureBytes[round % fixtureBytes.length];
      let damaged: Uint8Array;
      if (round % 2 === 0) {
        damaged = bytes.slice();
        for (let flips = 1 + Math.floor(next() * 4); flips > 0; flips -= 1) {
          damaged[Math.floor(next() * damaged.length)] = Math.floor(
            next() * 256,
          );
        }
      } else {
        damaged = new Uint8Array(Math.floor(next() * 400));
        for (let i = 0; i < damaged.length; i += 1) {
          damaged[i] = Math.floor(next() * 256);
        }
      }
      const result = parseTransaction(damaged);
      if (result.ok) {
        summarizeTransaction(
          result.transaction,
          new Map(Object.entries(c.tables)),
        );
      }
    }
  });
});
