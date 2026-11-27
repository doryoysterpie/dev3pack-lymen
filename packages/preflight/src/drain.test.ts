import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodePublicKey } from "./base58.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { drainPattern } from "./drain.ts";
import { preflightTransaction, type PreflightReport } from "./preflight.ts";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from "./programs.ts";
import {
  recordedRpc,
  type RecordedAccount,
  type Recording,
} from "./recorded.ts";

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
// One SOL transfer of 0.01 to the organizer, then an unknown program that has
// the user's token account writable.
const UNKNOWN = bytesOf("unknown program");

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
      rpc: recordedRpc({
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
    });
    assert.equal(result.drainPattern, true);
    assert.equal(result.summary.kind, "ready");
    assert.ok(result.summary.kind === "ready");
    // The summary is written for the fee payer, named by its role.
    assert.equal(result.summary.summary.signers.feePayer, "user");
    assert.deepEqual(
      result.summary.summary.effects.map((effect) => effect.kind),
      ["sol-out", "delegate-approved"],
    );
  });

  it("returns a summary that is plain JSON, with amounts as strings", async () => {
    const { summary } = await preflightTransaction(DRAINER, {
      rpc: recordedRpc(unknownOutcome(9_995_000, token(1000, ATTACKER))),
    });
    // JSON.stringify throws on a bigint, and the round trip drops undefined
    // fields and turns typed arrays into objects, so equality proves plainness.
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
    assert.ok(summary.kind === "ready");
    const out = summary.summary.effects[0];
    assert.ok(out.kind === "sol-out");
    assert.equal(out.lamports, "4990000000");
  });

  it("owes the same summary whether user is left out or given as the fee payer", async () => {
    const recording = unknownOutcome(9_995_000, token(1000, ATTACKER));
    const omitted = await preflightTransaction(DRAINER, {
      rpc: recordedRpc(recording),
    });
    const given = await preflightTransaction(DRAINER, {
      rpc: recordedRpc(recording),
      user: USER,
    });
    assert.deepEqual(given, omitted);
    assert.equal(omitted.drainPattern, true);
  });

  it("refuses a user that is not the fee payer, with no drain pattern", async () => {
    const result = await preflightTransaction(DRAINER, {
      rpc: recordedRpc(unknownOutcome(9_995_000, token(1000, ATTACKER))),
      user: ATTACKER,
    });
    assert.deepEqual(result, {
      summary: { kind: "user-not-fee-payer", feePayer: USER },
      drainPattern: false,
      simulatedAt: null,
    });
  });

  it("returns the slot and the blockhash the simulation ran against, outside the summary", async () => {
    const result = await preflightTransaction(DRAINER, {
      rpc: recordedRpc({
        ...unknownOutcome(9_995_000, token(1000, ATTACKER)),
        simulation: {
          ...unknownOutcome(9_995_000, token(1000, ATTACKER)).simulation,
          slot: 527004383,
          replacementBlockhash: "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW",
        },
      }),
    });
    assert.deepEqual(result.simulatedAt, {
      slot: 527004383,
      blockhash: "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW",
    });
    assert.ok(!JSON.stringify(result.summary).includes("527004383"));
  });

  it("refuses bytes that are not a transaction, with no drain pattern", async () => {
    assert.deepEqual(
      await preflightTransaction(new Uint8Array([1, 2, 3]), {
        rpc: recordedRpc(unknownOutcome(0, token(0, null))),
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
      rpc: recordedRpc({
        ...unknownOutcome(0, token(0, null)),
        genesisHash: MINT,
      }),
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
      "a token account emptied",
      unknownOutcome(4_990_000_000, token(0, null)),
      true,
    ],
    [
      "a new delegate on a token account",
      unknownOutcome(4_990_000_000, token(1000, ATTACKER)),
      true,
    ],
    [
      "a token account given a new owner",
      unknownOutcome(4_990_000_000, token(1000, null, ATTACKER)),
      true,
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
        rpc: recordedRpc(recording),
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
      summary: {
        effects,
        others: [],
        undecoded: [],
        signers: { feePayer: USER, others: [], unsigned: true },
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
        newAuthority: USER,
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
        destination: { address: USER },
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
