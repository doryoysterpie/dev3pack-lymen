// The owed answers come from agave's own tests of get_prioritization_fee
// (anza-xyz/agave a64fa73, compute-budget/src/compute_budget_limits.rs, from
// line 71) and from the PM's internal read of E-09 (m6).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as web3 from "@solana/web3.js";

import {
  cappedUnitLimit,
  MAX_COMPUTE_UNIT_LIMIT,
  priorityFeeLamports,
} from "./fee.ts";
import { summarizeTransaction } from "./summary.ts";
import { parseTransaction } from "./wire.ts";

const U64_MAX = "18446744073709551615";
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

describe("m6: the priority fee, as agave computes it", () => {
  it("is zero at a price of zero", () => {
    for (const units of [0, 1, MICRO_LAMPORTS_PER_LAMPORT]) {
      assert.equal(priorityFeeLamports("0", units), "0");
    }
  });

  it("rounds a fee under one lamport up to one", () => {
    assert.equal(
      priorityFeeLamports(String(MICRO_LAMPORTS_PER_LAMPORT - 1), 1),
      "1",
    );
    assert.equal(
      priorityFeeLamports(String(MICRO_LAMPORTS_PER_LAMPORT), 1),
      "1",
    );
    assert.equal(
      priorityFeeLamports(String(MICRO_LAMPORTS_PER_LAMPORT + 1), 1),
      "2",
    );
  });

  it("200 micro-lamports for 100,000 units is 20 lamports", () => {
    assert.equal(priorityFeeLamports("200", 100_000), "20");
  });

  it("saturates at the largest u64", () => {
    assert.equal(priorityFeeLamports(U64_MAX, MAX_COMPUTE_UNIT_LIMIT), U64_MAX);
  });

  it("the internal read's case: 1,400,000 units at 3,500,000,000 micro-lamports is 4.9 SOL", () => {
    assert.equal(priorityFeeLamports("3500000000", 1_400_000), "4900000000");
  });

  it("caps a requested limit at 1,400,000 units", () => {
    assert.equal(cappedUnitLimit(4_294_967_295), 1_400_000);
    assert.equal(cappedUnitLimit(200_000), 200_000);
  });
});

describe("m6: the summary shows the priority fee the wallet pays", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly user: string;
    readonly keys: Readonly<Record<string, string>>;
  };
  const user = new web3.PublicKey(fixture.user);
  const budget = web3.ComputeBudgetProgram;
  const transfer = web3.SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: new web3.PublicKey(fixture.keys.attacker),
    lamports: 1000,
  });

  function summary(instructions: web3.TransactionInstruction[]) {
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: fixture.keys.mint,
      instructions,
    }).compileToLegacyMessage();
    const bytes = new web3.VersionedTransaction(message, [
      new Uint8Array(64),
    ]).serialize();
    const parsed = parseTransaction(bytes);
    assert.ok(parsed.ok);
    return summarizeTransaction(parsed.transaction, new Map());
  }

  it("the internal read's case: 1,400,000 units at 3,500,000,000 micro-lamports", () => {
    const got = summary([
      budget.setComputeUnitLimit({ units: 1_400_000 }),
      budget.setComputeUnitPrice({ microLamports: 3_500_000_000 }),
      transfer,
    ]);
    assert.deepEqual(got.effects[0], {
      kind: "priority-fee",
      instruction: 1,
      microLamportsPerUnit: "3500000000",
      unitLimit: 1_400_000,
      lamports: "4900000000",
    });
    assert.deepEqual(got.others, [{ instruction: 0, kind: "compute-budget" }]);
  });

  it("a limit above 1,400,000 units is capped", () => {
    const got = summary([
      budget.setComputeUnitPrice({ microLamports: 1_000_000 }),
      budget.setComputeUnitLimit({ units: 4_294_967_295 }),
      transfer,
    ]);
    const fee = got.effects[0];
    assert.ok(fee.kind === "priority-fee");
    assert.equal(fee.unitLimit, 1_400_000);
    assert.equal(fee.lamports, "1400000");
  });

  it("with no limit set, gives the most the fee can be", () => {
    const fee = summary([
      budget.setComputeUnitPrice({ microLamports: 50_000 }),
      transfer,
    ]).effects[0];
    assert.ok(fee.kind === "priority-fee");
    assert.equal(fee.unitLimit, null);
    assert.equal(fee.lamports, "70000");
  });

  it("gives no fee for two price instructions, which the runtime refuses", () => {
    const got = summary([
      budget.setComputeUnitPrice({ microLamports: 50_000 }),
      budget.setComputeUnitPrice({ microLamports: 60_000 }),
      transfer,
    ]);
    assert.deepEqual(
      got.effects.map((effect) => effect.kind),
      ["sol-out"],
    );
    assert.equal(got.others.length, 2);
  });

  it("gives no fee at a price of zero", () => {
    const got = summary([
      budget.setComputeUnitPrice({ microLamports: 0 }),
      transfer,
    ]);
    assert.deepEqual(
      got.effects.map((effect) => effect.kind),
      ["sol-out"],
    );
  });

  it("audit of 1856942, bug 2: reads compute-budget prefixes with trailing data as agave does", () => {
    const withTrailing = (
      instruction: web3.TransactionInstruction,
      extra: number[],
    ) =>
      new web3.TransactionInstruction({
        programId: instruction.programId,
        keys: instruction.keys,
        data: Buffer.concat([instruction.data, Buffer.from(extra)]),
      });
    const got = summary([
      withTrailing(budget.setComputeUnitLimit({ units: 200_000 }), [0xff]),
      budget.setComputeUnitPrice({ microLamports: 50_000 }),
      transfer,
    ]);
    assert.deepEqual(got.undecoded, []);
    assert.deepEqual(got.effects[0], {
      kind: "priority-fee",
      instruction: 1,
      microLamportsPerUnit: "50000",
      unitLimit: 200_000,
      lamports: "10000",
    });

    const priceTrailing = summary([
      withTrailing(
        budget.setComputeUnitPrice({ microLamports: 50_000 }),
        [1, 2],
      ),
      transfer,
    ]);
    assert.deepEqual(priceTrailing.undecoded, []);
    assert.deepEqual(priceTrailing.effects[0], {
      kind: "priority-fee",
      instruction: 0,
      microLamportsPerUnit: "50000",
      unitLimit: null,
      lamports: "70000",
    });

    // Duplicate limit where one carries trailing data gives no fee, matching
    // agave's DuplicateInstruction refusal.
    const dup = summary([
      budget.setComputeUnitLimit({ units: 200_000 }),
      withTrailing(budget.setComputeUnitLimit({ units: 300_000 }), [0x01]),
      budget.setComputeUnitPrice({ microLamports: 50_000 }),
      transfer,
    ]);
    assert.deepEqual(dup.undecoded, []);
    assert.deepEqual(
      dup.effects.map((effect) => effect.kind),
      ["sol-out"],
    );
  });
});
