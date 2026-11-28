import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as web3 from "@solana/web3.js";

import { decodePublicKey } from "./base58.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { drainPattern } from "./drain.ts";
import { preflightTransaction, type PreflightReport } from "./preflight.ts";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from "./programs.ts";
import {
  recordedEndpoint,
  type RecordedAccount,
  type Recording,
} from "../test-support/recorded.ts";

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
const {
  attacker: ATTACKER,
  userTokenAccount: TOKEN_ACCOUNT,
  mint: MINT,
} = fixture.keys;

function bytesOf(start: string): Uint8Array {
  const found = fixture.cases.find((c) => c.name.startsWith(start));
  assert.ok(found, start);
  const bytes = decodeBase64(found.transaction);
  assert.ok(bytes !== null);
  return bytes;
}
const DRAINER = bytesOf("drainer: SOL balance out");

/**
 * The fixture "unknown program" (one SOL transfer of 0.01 to the organizer,
 * then an unknown program that has the user's token account writable), with
 * the Token program added to the unknown instruction's accounts. Only then
 * can that program change the token account, by a call to the Token program
 * (anza-xyz/agave a64fa73, program-runtime/src/invoke_context.rs:463 to
 * 470), and only then does the simulation list token balances
 * (svm/src/transaction_balances.rs:83 and :96). The fixture is unchanged.
 */
function unknownWithTokenProgram(): Uint8Array {
  const sent = web3.VersionedTransaction.deserialize(
    bytesOf("unknown program"),
  );
  const message = web3.TransactionMessage.decompile(sent.message);
  const [transfer, call] = message.instructions;
  assert.equal(call.programId.toBase58(), fixture.keys.unknownProgram);
  const compiled = new web3.TransactionMessage({
    payerKey: message.payerKey,
    recentBlockhash: message.recentBlockhash,
    instructions: [
      transfer,
      new web3.TransactionInstruction({
        programId: call.programId,
        data: call.data,
        keys: [
          ...call.keys,
          {
            pubkey: new web3.PublicKey(TOKEN_PROGRAM),
            isSigner: false,
            isWritable: false,
          },
        ],
      }),
    ],
  }).compileToLegacyMessage();
  return new web3.VersionedTransaction(compiled, sent.signatures).serialize();
}
const UNKNOWN = unknownWithTokenProgram();

function tokenData(
  amount: number,
  delegate: string | null,
  owner = USER,
): string {
  const data = new Uint8Array(165);
  data.set(decodePublicKey(MINT) ?? new Uint8Array(32), 0);
  data.set(decodePublicKey(owner) ?? new Uint8Array(32), 32);
  data[64] = amount & 0xff;
  data[65] = amount >> 8;
  if (delegate !== null) {
    data[72] = 1;
    data.set(decodePublicKey(delegate) ?? new Uint8Array(32), 76);
  }
  data[108] = 1;
  return encodeBase64(data);
}

const sol = (lamports: number): RecordedAccount => ({
  lamports,
  owner: SYSTEM_PROGRAM,
  data: ["", "base64"],
});
const token = (
  amount: number,
  delegate: string | null,
  owner = USER,
): RecordedAccount => ({
  lamports: 2_039_280,
  owner: TOKEN_PROGRAM,
  data: [tokenData(amount, delegate, owner), "base64"],
});

/** A recording for the unknown-program transaction with the given outcome. */
function unknownOutcome(
  solAfter: number,
  tokenAfter: RecordedAccount,
  err: unknown = null,
): Recording {
  return {
    accounts: {
      [USER]: sol(5_000_000_000),
      [TOKEN_ACCOUNT]: token(1000, null),
    },
    simulation: {
      err,
      accounts: { [USER]: sol(solAfter), [TOKEN_ACCOUNT]: tokenAfter },
    },
  };
}

describe("preflightTransaction, the server entry point", () => {
  it("decodes and simulates stored bytes and finds the drainer's drain pattern", async () => {
    const result = await preflightTransaction(DRAINER, {
      endpoint: recordedEndpoint({
        accounts: {
          [USER]: sol(5_000_000_000),
          [TOKEN_ACCOUNT]: token(1000, null),
        },
        simulation: {
          err: null,
          accounts: {
            [USER]: sol(9_995_000),
            [TOKEN_ACCOUNT]: token(1000, ATTACKER),
          },
        },
      }),
      user: USER,
    });
    assert.equal(result.drainPattern, true);
    assert.equal(result.summary.kind, "ready");
    assert.ok(result.summary.kind === "ready");
    // The summary is written for the fee payer, named by its role.
    assert.equal(result.summary.summary.signers.feePayer, "user");
    assert.deepEqual(
      result.summary.summary.effects.map((effect) => effect.kind),
      ["priority-fee", "sol-out", "delegate-approved"],
    );
  });

  it("returns a summary that is plain JSON, with amounts as strings", async () => {
    const { summary } = await preflightTransaction(DRAINER, {
      endpoint: recordedEndpoint(
        unknownOutcome(9_995_000, token(1000, ATTACKER)),
      ),
      user: USER,
    });
    // JSON.stringify throws on a bigint, and the round trip drops undefined
    // fields and turns typed arrays into objects, so equality proves plainness.
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
    assert.ok(summary.kind === "ready");
    const [fee, out] = summary.summary.effects;
    assert.ok(fee.kind === "priority-fee");
    assert.equal(fee.lamports, "70000");
    assert.ok(out.kind === "sol-out");
    assert.equal(out.lamports, "4990000000");
  });

  it("n3: yields no report when no wallet is named", async () => {
    const recording = unknownOutcome(9_995_000, token(1000, ATTACKER));
    const owed = {
      summary: { kind: "user-not-given" },
      drainPattern: false,
      simulatedAt: null,
    };
    // A JavaScript caller can leave user out, or pass something that is not
    // a public key.
    const run = (options: object) =>
      preflightTransaction(
        DRAINER,
        options as Parameters<typeof preflightTransaction>[1],
      );
    assert.deepEqual(
      await run({ endpoint: recordedEndpoint(recording) }),
      owed,
    );
    assert.deepEqual(
      await run({ endpoint: recordedEndpoint(recording), user: "not a key" }),
      owed,
    );
  });

  it("refuses a user that is not the fee payer, with no drain pattern", async () => {
    const result = await preflightTransaction(DRAINER, {
      endpoint: recordedEndpoint(
        unknownOutcome(9_995_000, token(1000, ATTACKER)),
      ),
      user: ATTACKER,
    });
    // The audit of 21e1f9f, item 1: a refusal report carries no address
    // either; the fee payer is the message's account 0.
    assert.deepEqual(result, {
      summary: { kind: "user-not-fee-payer", feePayer: "account 0" },
      drainPattern: false,
      simulatedAt: null,
    });
    assert.equal(
      /[1-9A-HJ-NP-Za-km-z]{32,}/.test(JSON.stringify(result)),
      false,
    );
  });

  it("returns the slot the simulation ran at, outside the summary, and not the RPC's blockhash", async () => {
    const result = await preflightTransaction(DRAINER, {
      endpoint: recordedEndpoint({
        ...unknownOutcome(9_995_000, token(1000, ATTACKER)),
        simulation: {
          ...unknownOutcome(9_995_000, token(1000, ATTACKER)).simulation,
          slot: 527004383,
          replacementBlockhash: "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW",
        },
      }),
      user: USER,
    });
    // The server output keeps no blockhash from the RPC (the PM's ruling on
    // A4 iii); the app's Preflight keeps it, checked.
    assert.deepEqual(result.simulatedAt, { slot: 527004383 });
    assert.ok(!JSON.stringify(result.summary).includes("527004383"));
    assert.ok(
      !JSON.stringify(result).includes(
        "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW",
      ),
    );
  });

  it("refuses bytes that are not a transaction, with no drain pattern", async () => {
    assert.deepEqual(
      await preflightTransaction(new Uint8Array([1, 2, 3]), {
        endpoint: recordedEndpoint(unknownOutcome(0, token(0, null))),
        user: USER,
      }),
      {
        summary: { kind: "malformed", problem: "truncated" },
        drainPattern: false,
        simulatedAt: null,
      },
    );
  });

  it("stops at an endpoint that is not devnet, with no drain pattern", async () => {
    const result = await preflightTransaction(DRAINER, {
      endpoint: recordedEndpoint({
        ...unknownOutcome(0, token(0, null)),
        genesisHash: MINT,
      }),
      user: USER,
    });
    assert.deepEqual(result, {
      summary: { kind: "not-devnet" },
      drainPattern: false,
      simulatedAt: null,
    });
  });
});

describe("drainPattern through the simulation, for an instruction limen cannot decode", () => {
  const cases: ReadonlyArray<readonly [string, Recording, boolean]> = [
    [
      "a payment of 0.01 SOL",
      unknownOutcome(4_990_000_000, token(1000, null)),
      false,
    ],
    [
      "the wallet left with less than a tenth of its SOL",
      unknownOutcome(499_999_999, token(1000, null)),
      true,
    ],
    [
      "the wallet left with exactly a tenth of its SOL",
      unknownOutcome(500_000_000, token(1000, null)),
      false,
    ],
    [
      // Ruling 20a: a simulated token sweep or token-state change is no
      // longer a drain pattern; the card for this transaction is the flagged
      // fallback card, since limen cannot decode its instruction.
      "a token account emptied",
      unknownOutcome(4_990_000_000, token(0, null)),
      false,
    ],
    [
      "a new delegate on a token account",
      unknownOutcome(4_990_000_000, token(1000, ATTACKER)),
      false,
    ],
    [
      "a token account given a new owner",
      unknownOutcome(4_990_000_000, token(1000, null, ATTACKER)),
      false,
    ],
    [
      "a delegate set to the wallet itself",
      unknownOutcome(4_990_000_000, token(1000, USER)),
      false,
    ],
    [
      "a sweep in a simulation that failed",
      unknownOutcome(0, token(0, ATTACKER), {
        InstructionError: [1, "Custom"],
      }),
      false,
    ],
  ];
  for (const [name, recording, owed] of cases) {
    it(`${name}: ${owed}`, async () => {
      const result = await preflightTransaction(UNKNOWN, {
        endpoint: recordedEndpoint(recording),
        user: USER,
      });
      assert.equal(result.drainPattern, owed);
    });
  }
});

describe("drainPattern on decoded effects", () => {
  const OTHER = ATTACKER;
  const report = (effects: unknown[]): PreflightReport =>
    ({
      kind: "ready",
      feePayerSet: false,
      summary: {
        effects,
        others: [],
        undecoded: [],
        signers: { feePayer: "user", others: [], unsigned: true },
        unresolvedAccounts: 0,
      },
      simulation: { status: "not-run", reason: "offline" },
      blocks: [],
    }) as PreflightReport;
  const base = { instruction: 0, program: "token" as const };
  const cases: ReadonlyArray<readonly [string, unknown, boolean]> = [
    [
      "owner moved to another address",
      {
        ...base,
        kind: "authority-changed",
        account: { address: TOKEN_ACCOUNT },
        authorityType: "AccountOwner",
        newAuthority: OTHER,
      },
      true,
    ],
    [
      "close authority moved to the wallet itself",
      {
        ...base,
        kind: "authority-changed",
        account: { address: TOKEN_ACCOUNT },
        authorityType: "CloseAccount",
        newAuthority: "user",
      },
      false,
    ],
    [
      "an authority removed",
      {
        ...base,
        kind: "authority-changed",
        account: { address: MINT },
        authorityType: "FreezeAccount",
        newAuthority: null,
      },
      false,
    ],
    [
      "account closed to another address",
      {
        ...base,
        kind: "account-closed",
        account: { address: TOKEN_ACCOUNT },
        destination: { address: OTHER },
      },
      true,
    ],
    [
      "account closed to the wallet",
      {
        ...base,
        kind: "account-closed",
        account: { address: TOKEN_ACCOUNT },
        destination: { address: "user" },
      },
      false,
    ],
    [
      "account closed to an unloaded lookup address",
      {
        ...base,
        kind: "account-closed",
        account: { address: TOKEN_ACCOUNT },
        destination: { table: MINT, index: 0 },
      },
      true,
    ],
    [
      "wallet assigned to a program",
      { instruction: 0, kind: "owner-assigned", newOwner: OTHER },
      true,
    ],
    [
      "a delegate approved",
      {
        ...base,
        kind: "delegate-approved",
        account: { address: TOKEN_ACCOUNT },
        delegate: { address: OTHER },
        mint: null,
        amount: "1",
        decimals: null,
      },
      true,
    ],
    [
      "a plain SOL payment",
      {
        instruction: 0,
        kind: "sol-out",
        to: { address: OTHER },
        lamports: "1000",
        reason: "transfer",
      },
      false,
    ],
  ];
  for (const [name, effect, owed] of cases) {
    it(`${name}: ${owed}`, () => {
      assert.equal(drainPattern(report([effect])), owed);
    });
  }
});
