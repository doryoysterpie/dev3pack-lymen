// The PM's guard on the owner's audit item 4: the report marks every account
// a wallet-signed instruction names, so the evidence a report exists for, the
// addresses the transaction sends to and the programs it calls, comes from
// the unmarked decode instead. The app's Preflight keeps it in memory for an
// evidence bundle's `recipients` and `program_ids`; a report never holds it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { endpointFor, recordedEndpoint } from "../test-support/recorded.ts";
import { decodePublicKey } from "./base58.ts";
import { preflight, toReport } from "./preflight.ts";
import {
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly cases: readonly {
    readonly name: string;
    readonly transaction: string;
  }[];
};
const USER = fixture.user;
const K = fixture.keys;
const drainer = fixture.cases[0].transaction;

const offline = () =>
  endpointFor(async () => {
    throw new Error("offline");
  }, "x");

const wallet = (lamports: number) => ({
  lamports,
  owner: SYSTEM_PROGRAM,
  data: ["", "base64"] as const,
});
const tokenOf = (amount: number) => {
  const data = new Uint8Array(165);
  data.set(decodePublicKey(K.mint) ?? new Uint8Array(32), 0);
  data.set(decodePublicKey(USER) ?? new Uint8Array(32), 32);
  data[64] = amount;
  data[108] = 1;
  return {
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM,
    data: [Buffer.from(data).toString("base64"), "base64"] as const,
  };
};

describe("the PM's guard on item 4: a bundle's recipients and program IDs come from the unmarked decode", () => {
  it("keeps the drainer's recipient and programs in memory, and out of the report", async () => {
    for (const endpoint of [
      offline(),
      recordedEndpoint({
        accounts: {
          [USER]: wallet(5_000_000_000),
          [K.userTokenAccount]: tokenOf(200),
        },
        simulation: { err: null, accounts: {} },
      }),
    ]) {
      const result = await preflight(endpoint, drainer, USER);
      assert.ok(result.kind === "ready");
      // The drainer sends SOL to the attacker and approves the attacker as
      // delegate: one recipient. It calls the compute budget, Memo, System
      // and Token programs.
      assert.deepEqual(result.recipients, [K.attacker]);
      assert.deepEqual(result.programIds, [
        COMPUTE_BUDGET_PROGRAM,
        MEMO_PROGRAM,
        SYSTEM_PROGRAM,
        TOKEN_PROGRAM,
      ]);
      const report = JSON.stringify(toReport(result));
      assert.equal(report.includes(K.attacker), false);
      assert.equal(report.includes("recipients"), false);
      assert.equal(report.includes("programIds"), false);
    }
  });

  it("lists a token transfer's destination, since limen reads no account", async () => {
    const user = new web3.PublicKey(USER);
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: K.mint,
      instructions: [
        spl.createTransferInstruction(
          new web3.PublicKey(K.userToken2022Account),
          new web3.PublicKey(K.userTokenAccount),
          user,
          5,
        ),
      ],
    }).compileToLegacyMessage();
    const bytes = new web3.VersionedTransaction(message).serialize();
    const result = await preflight(
      offline(),
      Buffer.from(bytes).toString("base64"),
      USER,
    );
    assert.ok(result.kind === "ready");
    // The destination could be another of the wallet's token accounts; no
    // read says whose it is (ruling 20a), so it is listed.
    assert.deepEqual(result.recipients, [K.userTokenAccount]);
    assert.deepEqual(result.programIds, [TOKEN_PROGRAM]);
  });
});
