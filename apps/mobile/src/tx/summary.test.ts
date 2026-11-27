import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodeBase64 } from "./base64.ts";
import { summarizeTransaction, type TransactionSummary } from "./summary.ts";
import { parseTransaction, type ParsedTransaction } from "./wire.ts";

interface FixtureCase {
  readonly name: string;
  readonly transaction: string;
  readonly tables: Readonly<Record<string, readonly string[]>>;
  readonly owed: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/tx/e09-transactions.json", import.meta.url),
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

/** The summary with each "other" instruction cut to its index and kind. */
function comparable(summary: TransactionSummary): unknown {
  return {
    ...summary,
    others: summary.others.map(({ instruction, decoded }) => ({
      instruction,
      kind: decoded.kind,
    })),
  };
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
      const summary = summarizeTransaction(
        parsed(c.transaction),
        fixture.user,
        tables,
      );
      assert.deepEqual(comparable(summary), c.owed);
    });
  }

  it("the drainer shows balance out and a delegate approved", () => {
    const c = caseNamed("drainer: SOL balance out");
    const summary = summarizeTransaction(
      parsed(c.transaction),
      fixture.user,
      new Map(),
    );
    assert.deepEqual(
      summary.effects.map((effect) => effect.kind),
      ["sol-out", "delegate-approved"],
    );
    assert.equal(summary.undecoded.length, 0);
  });

  it("an unknown program is listed as undecoded, not a crash", () => {
    const c = caseNamed("unknown program");
    const summary = summarizeTransaction(
      parsed(c.transaction),
      fixture.user,
      new Map(),
    );
    assert.deepEqual(
      summary.undecoded.map((entry) => entry.reason),
      ["unknown-program"],
    );
  });
});

describe("no crash on damaged transactions", () => {
  // A small deterministic generator, so a failure can be replayed.
  let state = 0x2545f491;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };

  it("parses or refuses 20000 damaged copies of the fixtures, and summarizes every one it parses", () => {
    let parsedCount = 0;
    for (let round = 0; round < 20000; round += 1) {
      const c = fixture.cases[round % fixture.cases.length];
      const bytes = decodeBase64(c.transaction);
      assert.ok(bytes !== null);
      let damaged: Uint8Array;
      const mode = round % 3;
      if (mode === 0) {
        damaged = bytes.slice(0, Math.floor(next() * bytes.length));
      } else if (mode === 1) {
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
        parsedCount += 1;
        summarizeTransaction(
          result.transaction,
          fixture.user,
          new Map(Object.entries(c.tables)),
        );
      } else {
        assert.equal(typeof result.problem, "string");
      }
    }
    assert.ok(
      parsedCount > 0,
      "no damaged copy parsed, so summaries went untested",
    );
  });
});
