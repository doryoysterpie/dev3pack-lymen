// The owner's Codex audit of E-09 at 2a7d3e2, findings 6, 7, 8 and 12: the
// simulation evidence the pre-flight uses, each with the answer it owes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as web3 from "@solana/web3.js";

import { decodePublicKey } from "./base58.ts";
import { encodeBase64 } from "./base64.ts";
import { encodeTransaction } from "./encode.ts";
import { preflight, preflightTransaction } from "./preflight.ts";
import {
  DEVNET_GENESIS_HASH,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import { recordedRpc } from "./recorded.ts";
import type { Fetch, Rpc } from "./rpc.ts";
import { jsonRpc } from "./rpc.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as { readonly user: string; readonly keys: Readonly<Record<string, string>> };

const K = fixture.keys;
const USER = fixture.user;
const key = (address: string) => new web3.PublicKey(address);
const user = key(USER);
const attacker = key(K.attacker);
const tokenAccount = key(K.userTokenAccount);

function build(instructions: web3.TransactionInstruction[]): Uint8Array {
  const message = new web3.TransactionMessage({
    payerKey: user,
    recentBlockhash: K.mint,
    instructions,
  }).compileToLegacyMessage();
  const signatures = Array.from(
    { length: message.header.numRequiredSignatures },
    () => new Uint8Array(64),
  );
  return new web3.VersionedTransaction(message, signatures).serialize();
}

type Json = Record<string, unknown>;

const system = (lamports: number | string) => ({
  lamports,
  owner: SYSTEM_PROGRAM,
  data: ["", "base64"],
});

/** A 165-byte token account of the fixture mint owned by the wallet. */
function tokenState(amount: number, delegate: string | null) {
  const data = new Uint8Array(165);
  data.set(decodePublicKey(K.mint) ?? new Uint8Array(32), 0);
  data.set(decodePublicKey(USER) ?? new Uint8Array(32), 32);
  data[64] = amount;
  if (delegate !== null) {
    data[72] = 1;
    data.set(decodePublicKey(delegate) ?? new Uint8Array(32), 76);
    data[121] = 255;
  }
  data[108] = 1;
  return {
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM,
    data: [encodeBase64(data), "base64"],
  };
}

/**
 * A JSON-RPC endpoint that passes the devnet check and answers each call
 * from the functions given. reads counts getMultipleAccounts calls.
 */
function endpoint(answers: {
  accounts: (addresses: string[], read: number) => unknown[];
  simulation: (addresses: string[]) => Json;
  id?: (id: number, method: string) => number;
  /** The simulation's context slot; 2 when left out. */
  slot?: unknown;
}): Fetch {
  let reads = 0;
  return async (_url, init) => {
    const request = JSON.parse(init.body) as {
      id: number;
      method: string;
      params: unknown[];
    };
    let result: unknown;
    if (request.method === "getGenesisHash") result = DEVNET_GENESIS_HASH;
    else if (request.method === "getMultipleAccounts") {
      reads += 1;
      result = {
        context: { slot: 1 },
        value: answers.accounts(request.params[0] as string[], reads),
      };
    } else if (request.method === "simulateTransaction") {
      const options = request.params[1] as {
        accounts: { addresses: string[] };
      };
      result = {
        context: { slot: "slot" in answers ? answers.slot : 2 },
        value: answers.simulation(options.accounts.addresses),
      };
    }
    const id = answers.id ? answers.id(request.id, request.method) : request.id;
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id, result }),
    };
  };
}

const transfer = () =>
  web3.SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: attacker,
    lamports: 9_500_000_000,
  });

describe("audit 6: the balance change comes from the simulation's own run", () => {
  it("uses the simulation's pre-balance, not an earlier read", async () => {
    // The read sees 1 SOL; a payment of 9 SOL lands before the simulation,
    // which starts from 10 SOL and ends at 0.5 SOL.
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER ? system(1_000_000_000) : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER ? system(500_000_000) : system(9_500_000_000),
          ),
          preBalances: [10_000_000_000, 0, 1],
          postBalances: [500_000_000, 9_500_000_000, 1],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
    const result = await preflightTransaction(build([transfer()]), {
      rpc,
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    const simulation = result.summary.simulation;
    assert.ok(simulation.status === "ran");
    const sol = simulation.changes.find((change) => change.kind === "sol");
    assert.ok(sol !== undefined && sol.kind === "sol");
    assert.equal(sol.before, "10000000000");
    assert.equal(sol.after, "500000000");
    assert.equal(result.drainPattern, true);
  });

  it("does not use the simulation when an account changed between the two reads", async () => {
    // Another transaction approves a delegate between the read before the
    // simulation and the read after it.
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses, read) =>
          addresses.map((address) =>
            address === USER
              ? system(5_000_000_000)
              : address === K.userTokenAccount
                ? tokenState(9, read === 1 ? null : K.attacker)
                : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER
              ? system(4_999_995_000)
              : tokenState(9, K.attacker),
          ),
          preBalances: [5_000_000_000, 2_039_280, 1],
          postBalances: [4_999_995_000, 2_039_280, 1],
          // No token program is among the accounts, so agave lists no token
          // balances (svm/src/transaction_balances.rs:83 and :96).
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
    const memo = new web3.TransactionInstruction({
      programId: key(K.unknownProgram),
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1]),
    });
    const result = await preflightTransaction(build([memo]), {
      rpc,
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
    assert.ok(result.summary.blocks.includes("simulation-not-run"));
    assert.equal(result.drainPattern, false);
  });
});

describe("audit 7: the simulation must answer what was asked", () => {
  it("an Rpc that returns no account for the one asked is not used", async () => {
    const recorded = recordedRpc({
      accounts: { [USER]: system(5_000_000_000) as never },
      simulation: { err: null, accounts: {} },
    });
    const rpc: Rpc = {
      ...recorded,
      simulate: async (base64, addresses) => ({
        ...(await recorded.simulate(base64, addresses)),
        accounts: [],
      }),
    };
    const result = await preflight(
      rpc,
      encodeBase64(build([transfer()])),
      USER,
    );
    assert.ok(result.kind === "ready");
    assert.equal(result.simulation.status, "not-run");
    assert.deepEqual(result.blocks, ["simulation-not-run"]);
  });

  it("an answer that carries another request's id is not used", async () => {
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER ? system(5_000_000_000) : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map(() => system(1)),
          preBalances: [5_000_000_000, 0, 1],
          postBalances: [5_000_000_000, 0, 1],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
        id: (id, method) => (method === "simulateTransaction" ? id + 1000 : id),
      }),
      "x",
    );
    const result = await preflight(
      rpc,
      encodeBase64(build([transfer()])),
      USER,
    );
    assert.ok(result.kind === "ready");
    assert.equal(result.simulation.status, "not-run");
  });
});

describe("audit 8: a malformed balance is refused, not thrown later", () => {
  it("lamports written as text are not used, and the report still builds", async () => {
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER ? system("unknown") : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER ? system(1) : null,
          ),
          preBalances: [5_000_000_000, 0, 1],
          postBalances: [1, 0, 1],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
    const result = await preflightTransaction(build([transfer()]), {
      rpc,
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
  });

  // Each balance an Rpc returns must be a whole number from 0 to the largest
  // u64, written in decimal; anything else holds signing, through a custom Rpc
  // as through jsonRpc, and the report still builds.
  const notWhole = [
    "unknown",
    "-1",
    "1.5",
    "01",
    "1e3",
    "18446744073709551616",
  ];
  const solTransfer = recordedRpc({
    accounts: { [USER]: system(5_000_000_000) as never },
    simulation: { err: null, accounts: { [USER]: system(1) as never } },
  });

  for (const bad of notWhole) {
    it(`an Rpc whose pre-balance is ${JSON.stringify(bad)} is not used`, async () => {
      const rpc: Rpc = {
        ...solTransfer,
        simulate: async (base64, addresses) => ({
          ...(await solTransfer.simulate(base64, addresses)),
          preBalances: [bad, "0", "1"],
        }),
      };
      const result = await preflightTransaction(build([transfer()]), {
        rpc,
        user: USER,
      });
      assert.ok(result.summary.kind === "ready");
      assert.equal(result.summary.simulation.status, "not-run");
      assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
      assert.equal(result.drainPattern, false);
    });
  }

  it("an Rpc whose token amounts are not whole numbers is not used", async () => {
    const recorded = recordedRpc({
      accounts: {
        [USER]: system(5_000_000_000) as never,
        [K.userTokenAccount]: tokenState(200, null) as never,
      },
      simulation: {
        err: null,
        accounts: {
          [USER]: system(4_999_995_000) as never,
          [K.userTokenAccount]: tokenState(0, null) as never,
        },
      },
    });
    for (const which of ["preTokenBalances", "postTokenBalances"] as const) {
      const rpc: Rpc = {
        ...recorded,
        simulate: async (base64, addresses) => {
          const simulation = await recorded.simulate(base64, addresses);
          return {
            ...simulation,
            [which]: (simulation[which] ?? []).map((balance) => ({
              ...balance,
              amount: "unknown",
            })),
          };
        },
      };
      const result = await preflightTransaction(
        build([
          new web3.TransactionInstruction({
            programId: new web3.PublicKey(TOKEN_PROGRAM),
            keys: [
              { pubkey: tokenAccount, isSigner: false, isWritable: true },
              { pubkey: attacker, isSigner: false, isWritable: true },
              { pubkey: user, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([3, 200, 0, 0, 0, 0, 0, 0, 0]),
          }),
        ]),
        { rpc, user: USER },
      );
      assert.ok(result.summary.kind === "ready", which);
      assert.equal(result.summary.simulation.status, "not-run", which);
      assert.deepEqual(result.summary.blocks, ["simulation-not-run"], which);
    }
  });

  // jsonRpc itself refuses each simulated balance that is not a whole amount:
  // text, a sign, a fraction, a leading zero, past the largest u64, or a JSON
  // number past 2^53, where precision is already lost.
  const refusedAmounts: readonly unknown[] = [
    "unknown",
    "-1",
    "01",
    "18446744073709551616",
    -1,
    1.5,
    2 ** 53 + 2,
  ];
  const simulateWith = (value: Json) =>
    jsonRpc(
      endpoint({
        accounts: () => [],
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map(() => system(1)),
          preBalances: [5_000_000_000, 0, 1],
          postBalances: [4_999_995_000, 0, 1],
          preTokenBalances: [],
          postTokenBalances: [],
          ...value,
        }),
      }),
      "x",
    ).simulate(encodeBase64(build([transfer()])), [USER]);
  const tokenEntry = (amount: unknown) => ({
    accountIndex: 1,
    mint: K.mint,
    owner: USER,
    uiTokenAmount: { amount },
  });

  for (const bad of refusedAmounts) {
    it(`jsonRpc refuses the simulated balance ${JSON.stringify(bad)}`, async () => {
      for (const value of [
        { preBalances: [bad, 0, 1] },
        { postBalances: [bad, 0, 1] },
        { preTokenBalances: [tokenEntry(bad)] },
        { postTokenBalances: [tokenEntry(bad)] },
      ]) {
        await assert.rejects(simulateWith(value), {
          reason: "shape",
          message: /not a whole amount/,
        });
      }
    });
  }

  it("jsonRpc keeps each whole simulated balance, as a decimal string", async () => {
    const simulation = await simulateWith({
      preBalances: [5_000_000_000, "18446744073709551615", 0],
      preTokenBalances: [tokenEntry("200")],
      postTokenBalances: [tokenEntry(30)],
    });
    assert.deepEqual(simulation.preBalances, [
      "5000000000",
      "18446744073709551615",
      "0",
    ]);
    assert.deepEqual(simulation.postBalances, ["4999995000", "0", "1"]);
    assert.deepEqual(
      simulation.preTokenBalances?.map((balance) => balance.amount),
      ["200"],
    );
    assert.deepEqual(
      simulation.postTokenBalances?.map((balance) => balance.amount),
      ["30"],
    );
  });
});

describe("audit 12: more writable accounts than limen watches", () => {
  it("does not use the simulation, so a sweep past the 100th account is not missed silently", async () => {
    const others = Array.from({ length: 99 }, () =>
      web3.PublicKey.unique(),
    ).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
    const call = new web3.TransactionInstruction({
      programId: key(K.unknownProgram),
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        ...others,
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1]),
    });
    // Past web3.js's size limit, so encoded here; the pre-flight reads any
    // length.
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: K.mint,
      instructions: [call],
    }).compileToV0Message();
    const bytes = encodeTransaction([new Uint8Array(64)], {
      version: 0,
      header: message.header,
      staticKeys: message.staticAccountKeys.map((k) => k.toBase58()),
      recentBlockhash: K.mint,
      instructions: message.compiledInstructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountIndexes: ix.accountKeyIndexes,
        data: ix.data,
      })),
      lookups: [],
    });
    const result = await preflightTransaction(bytes, {
      rpc: recordedRpc({
        accounts: {
          [USER]: system(5_000_000_000) as never,
          [K.userTokenAccount]: tokenState(200, null) as never,
        },
        simulation: {
          err: null,
          accounts: {
            [USER]: system(4_999_995_000) as never,
            [K.userTokenAccount]: tokenState(0, null) as never,
          },
        },
      }),
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
    assert.ok(result.summary.blocks.includes("simulation-not-run"));
  });

  it("does not use the simulation when a writable account sits behind a lookup table limen could not read", async () => {
    // The wallet's token account is written through a lookup table that the
    // RPC does not return, so its address is unknown and it cannot be
    // watched; the run sweeps it.
    const table = new web3.AddressLookupTableAccount({
      key: web3.PublicKey.unique(),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [tokenAccount],
      },
    });
    const sweep = new web3.TransactionInstruction({
      programId: key(K.unknownProgram),
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1]),
    });
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: K.mint,
      instructions: [sweep],
    }).compileToV0Message([table]);
    assert.equal(message.addressTableLookups.length, 1);
    const result = await preflightTransaction(
      new web3.VersionedTransaction(message, [new Uint8Array(64)]).serialize(),
      {
        rpc: recordedRpc({
          accounts: {
            [USER]: system(5_000_000_000) as never,
            [K.userTokenAccount]: tokenState(200, null) as never,
          },
          simulation: {
            err: null,
            accounts: {
              [USER]: system(4_999_995_000) as never,
              [K.userTokenAccount]: tokenState(0, null) as never,
            },
          },
        }),
        user: USER,
      },
    );
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "not-run",
      reason:
        "a writable account comes from a lookup table limen could not read",
    });
    assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
  });
});

describe("audit 6: the rest of the same-run evidence", () => {
  it("a simulation that gives no balances of its own run is not used", async () => {
    const result = await preflight(
      recordedRpc({
        accounts: { [USER]: system(5_000_000_000) as never },
        simulation: {
          err: null,
          accounts: { [USER]: system(4_999_995_000) as never },
          omitBalances: true,
        },
      }),
      encodeBase64(build([transfer()])),
      USER,
    );
    assert.ok(result.kind === "ready");
    assert.deepEqual(result.simulation, {
      status: "not-run",
      reason: "the simulation did not return the balances of its own run",
    });
  });

  it("a token account's amounts come from the run, not from a stale read", async () => {
    // The read shows 250 base units; the run starts from 200 and leaves 30,
    // more than a tenth, so there is no sweep. The unknown program moves the
    // tokens by a call to the token program, which is among the accounts.
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER
              ? system(5_000_000_000)
              : address === K.userTokenAccount
                ? tokenState(250, null)
                : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER ? system(4_999_995_000) : tokenState(30, null),
          ),
          preBalances: [5_000_000_000, 2_039_280, 1, 1],
          postBalances: [4_999_995_000, 2_039_280, 1, 1],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: K.mint,
              owner: USER,
              uiTokenAmount: { amount: "200" },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: K.mint,
              owner: USER,
              uiTokenAmount: { amount: "30" },
            },
          ],
        }),
      }),
      "x",
    );
    const call = new web3.TransactionInstruction({
      programId: key(K.unknownProgram),
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        {
          pubkey: new web3.PublicKey(TOKEN_PROGRAM),
          isSigner: false,
          isWritable: false,
        },
      ],
      data: Buffer.from([1]),
    });
    const result = await preflightTransaction(build([call]), {
      rpc,
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    const simulation = result.summary.simulation;
    assert.ok(simulation.status === "ran");
    const change = simulation.changes.find((c) => c.kind === "token");
    assert.ok(change !== undefined && change.kind === "token");
    assert.equal(change.before, "200");
    assert.equal(change.after, "30");
    assert.equal(result.drainPattern, false);
  });
});

describe("fix check N2: token balances come only with a token program", () => {
  // agave a64fa73, svm/src/transaction_balances.rs:83 and :96: the
  // simulation lists token balances only when a token program is among the
  // transaction's accounts, so without one both lists are empty.
  it("a System transfer into the wallet's own token account is simulated, with no token change", async () => {
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER
              ? system(5_000_000_000)
              : address === K.userTokenAccount
                ? tokenState(9, null)
                : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER ? system(4_999_994_000) : tokenState(9, null),
          ),
          preBalances: [5_000_000_000, 2_039_280, 1],
          postBalances: [4_999_994_000, 2_040_280, 1],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
    const result = await preflightTransaction(
      build([
        web3.SystemProgram.transfer({
          fromPubkey: user,
          toPubkey: tokenAccount,
          lamports: 1000,
        }),
      ]),
      { rpc, user: USER },
    );
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "ran",
      fromReadBefore: [
        "ownerBefore",
        "dataLengthBefore",
        "delegateBefore",
        "delegatedAmountBefore",
        "closeAuthorityBefore",
      ],
      err: null,
      changes: [
        {
          kind: "sol",
          account: "user",
          before: "5000000000",
          after: "4999994000",
          ownerBefore: SYSTEM_PROGRAM,
          ownerAfter: SYSTEM_PROGRAM,
          dataLengthBefore: 0,
          dataLengthAfter: 0,
        },
      ],
    });
    assert.deepEqual(result.summary.blocks, []);
    assert.equal(result.drainPattern, false);
  });

  it("re-audit A1: with no token program, a run that shows the token account changed is not used", async () => {
    // Nothing in the transaction can change the token account, so a new
    // delegate in the run's account state did not come from it.
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER
              ? system(5_000_000_000)
              : address === K.userTokenAccount
                ? tokenState(9, null)
                : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER
              ? system(4_999_994_000)
              : tokenState(9, K.attacker),
          ),
          preBalances: [5_000_000_000, 2_039_280, 1],
          postBalances: [4_999_994_000, 2_040_280, 1],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
    const result = await preflightTransaction(
      build([
        web3.SystemProgram.transfer({
          fromPubkey: user,
          toPubkey: tokenAccount,
          lamports: 1000,
        }),
      ]),
      { rpc, user: USER },
    );
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "not-run",
      reason:
        "the simulation's token balances do not match its own account state",
    });
    assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
    assert.equal(result.drainPattern, false);
  });

  it("an address behind a lookup table limen could not read may be a token program, so the token balances are still owed", async () => {
    const table = new web3.AddressLookupTableAccount({
      key: web3.PublicKey.unique(),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [new web3.PublicKey(TOKEN_PROGRAM)],
      },
    });
    const call = new web3.TransactionInstruction({
      programId: key(K.unknownProgram),
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        {
          pubkey: new web3.PublicKey(TOKEN_PROGRAM),
          isSigner: false,
          isWritable: false,
        },
      ],
      data: Buffer.from([1]),
    });
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: K.mint,
      instructions: [call],
    }).compileToV0Message([table]);
    assert.equal(message.addressTableLookups.length, 1);
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER
              ? system(5_000_000_000)
              : address === K.userTokenAccount
                ? tokenState(9, null)
                : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER ? system(4_999_995_000) : tokenState(0, null),
          ),
          preBalances: [5_000_000_000, 2_039_280, 1, 1],
          postBalances: [4_999_995_000, 2_039_280, 1, 1],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
    const result = await preflightTransaction(
      new web3.VersionedTransaction(message, [new Uint8Array(64)]).serialize(),
      { rpc, user: USER },
    );
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "not-run",
      reason: "the simulation's token balances do not match the accounts read",
    });
    assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
  });
});

describe("fix check: a failed run claims no changes", () => {
  // When the run fails, agave returns every requested account as null
  // (a64fa73, rpc/src/rpc.rs:3554 and :3555), which says nothing about what
  // the transaction would do.
  const failed = { InstructionError: [0, { Custom: 1 }] };
  const tokenTransfer = () =>
    build([
      new web3.TransactionInstruction({
        programId: new web3.PublicKey(TOKEN_PROGRAM),
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 200, 0, 0, 0, 0, 0, 0, 0]),
      }),
    ]);

  it("a token transfer whose run fails reports the error and no change", async () => {
    const result = await preflightTransaction(tokenTransfer(), {
      rpc: recordedRpc({
        accounts: {
          [USER]: system(5_000_000_000) as never,
          [K.userTokenAccount]: tokenState(200, null) as never,
        },
        simulation: { err: failed, accounts: {} },
      }),
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "ran",
      fromReadBefore: [
        "ownerBefore",
        "dataLengthBefore",
        "delegateBefore",
        "delegatedAmountBefore",
        "closeAuthorityBefore",
      ],
      err: failed,
      changes: [],
    });
    assert.deepEqual(result.summary.blocks, ["simulation-failed"]);
    assert.equal(result.drainPattern, false);
  });

  it("the same, through jsonRpc with agave's null accounts", async () => {
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER
              ? system(5_000_000_000)
              : address === K.userTokenAccount
                ? tokenState(200, null)
                : null,
          ),
        simulation: (addresses) => ({
          err: failed,
          logs: [],
          accounts: addresses.map(() => null),
          preBalances: [5_000_000_000, 2_039_280, 0, 1],
          postBalances: [4_999_995_000, 2_039_280, 0, 1],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: K.mint,
              owner: USER,
              uiTokenAmount: { amount: "200" },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: K.mint,
              owner: USER,
              uiTokenAmount: { amount: "200" },
            },
          ],
        }),
      }),
      "x",
    );
    const result = await preflightTransaction(tokenTransfer(), {
      rpc,
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "ran",
      fromReadBefore: [
        "ownerBefore",
        "dataLengthBefore",
        "delegateBefore",
        "delegatedAmountBefore",
        "closeAuthorityBefore",
      ],
      err: failed,
      changes: [],
    });
    assert.deepEqual(result.summary.blocks, ["simulation-failed"]);
  });
});

describe("re-audit A1 and A2: the token balances agree with the run's own accounts", () => {
  // A Token transfer of 5 from the wallet's token account to the attacker.
  // Accounts: the wallet, the token account (index 1), the attacker, the
  // Token program.
  const transferFive = () =>
    build([
      new web3.TransactionInstruction({
        programId: new web3.PublicKey(TOKEN_PROGRAM),
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 5, 0, 0, 0, 0, 0, 0, 0]),
      }),
    ]);
  const tokenOf = (amount: number, owner = USER, mint = K.mint) => {
    const data = new Uint8Array(165);
    data.set(decodePublicKey(mint) ?? new Uint8Array(32), 0);
    data.set(decodePublicKey(owner) ?? new Uint8Array(32), 32);
    data[64] = amount;
    data[108] = 1;
    return {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM,
      data: [encodeBase64(data), "base64"],
    };
  };
  const entry = (amount: string, owner = USER, mint = K.mint) => ({
    accountIndex: 1,
    mint,
    owner,
    uiTokenAmount: { amount },
  });
  const run = (
    read: unknown,
    after: unknown,
    preTokenBalances: unknown[],
    postTokenBalances: unknown[],
  ) =>
    preflightTransaction(transferFive(), {
      rpc: jsonRpc(
        endpoint({
          accounts: (addresses) =>
            addresses.map((address) =>
              address === USER
                ? system(5_000_000_000)
                : address === K.userTokenAccount
                  ? read
                  : null,
            ),
          simulation: (addresses) => ({
            err: null,
            logs: [],
            accounts: addresses.map((address) =>
              address === USER
                ? system(4_999_995_000)
                : address === K.userTokenAccount
                  ? after
                  : null,
            ),
            preBalances: [5_000_000_000, 2_039_280, 0, 1],
            postBalances: [4_999_995_000, 2_039_280, 0, 1],
            preTokenBalances,
            postTokenBalances,
          }),
        }),
        "x",
      ),
      user: USER,
    });
  const READ = "the simulation's token balances do not match the accounts read";
  const OWN =
    "the simulation's token balances do not match its own account state";
  const notUsed = async (
    result: ReturnType<typeof run>,
    reason: string,
  ): Promise<void> => {
    const { summary, drainPattern } = await result;
    assert.ok(summary.kind === "ready");
    assert.deepEqual(summary.simulation, { status: "not-run", reason });
    assert.deepEqual(summary.blocks, ["simulation-not-run"]);
    assert.equal(drainPattern, false);
  };

  it("uses balances that agree with the account the run returns", async () => {
    const { summary } = await run(
      tokenOf(200),
      tokenOf(195),
      [entry("200")],
      [entry("195")],
    );
    assert.ok(summary.kind === "ready");
    assert.ok(summary.simulation.status === "ran");
    const change = summary.simulation.changes.find((c) => c.kind === "token");
    assert.ok(change !== undefined && change.kind === "token");
    assert.equal(change.before, "200");
    assert.equal(change.after, "195");
  });

  it("A1: an open account with no post-balance entry is not read as swept", () =>
    notUsed(run(tokenOf(200), tokenOf(195), [entry("200")], []), OWN));

  it("A1: a post-balance entry does not hide the zero the account shows", () =>
    notUsed(
      run(tokenOf(200), tokenOf(0), [entry("200")], [entry("200")]),
      OWN,
    ));

  it("A1: a post-balance entry whose mint is not the account's is refused", () =>
    notUsed(
      run(
        tokenOf(200),
        tokenOf(195),
        [entry("200")],
        [entry("195", USER, K.attacker)],
      ),
      OWN,
    ));

  it("A1: a post-balance entry whose owner is not the account's is refused", () =>
    notUsed(
      run(
        tokenOf(200),
        tokenOf(195),
        [entry("200")],
        [entry("195", K.attacker)],
      ),
      OWN,
    ));

  it("A1: a closed account with a post-balance entry is refused", () =>
    notUsed(run(tokenOf(200), null, [entry("200")], [entry("0")]), OWN));

  it("A1: two post-balance entries for one account are refused", () =>
    notUsed(
      run(
        tokenOf(200),
        tokenOf(195),
        [entry("200")],
        [entry("195"), entry("0")],
      ),
      OWN,
    ));

  it("A1: two pre-balance entries for one account are refused", () =>
    notUsed(
      run(
        tokenOf(200),
        tokenOf(195),
        [entry("200"), entry("0")],
        [entry("195")],
      ),
      READ,
    ));

  it("A1: a pre-balance entry whose mint is not the account's is refused", () =>
    notUsed(
      run(
        tokenOf(200),
        tokenOf(195),
        [entry("200", USER, K.attacker)],
        [entry("195")],
      ),
      READ,
    ));

  it("A2: an account the run shows as the wallet's is not skipped when the read named another owner", () =>
    notUsed(
      run(
        tokenOf(200, K.attacker),
        tokenOf(195),
        [entry("200")],
        [entry("195")],
      ),
      READ,
    ));
});

describe("re-audit A3: recordedRpc's post state agrees with its balances", () => {
  // A token account left out of simulation.accounts is recorded as
  // unchanged: its post state and its post balances are both the read's.
  const recording = {
    accounts: {
      [USER]: system(5_000_000_000) as never,
      [K.userTokenAccount]: tokenState(200, null) as never,
    },
    simulation: {
      err: null,
      accounts: { [USER]: system(4_999_995_000) as never },
    },
  };
  // A Token Revoke on the wallet's token account: source, then owner.
  const revokeOwn = () =>
    build([
      new web3.TransactionInstruction({
        programId: new web3.PublicKey(TOKEN_PROGRAM),
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([5]),
      }),
    ]);

  it("returns the read's state for an account left out, as its balances do", async () => {
    const rpc = recordedRpc(recording);
    const transaction = encodeBase64(revokeOwn());
    const simulation = await rpc.simulate(transaction, [
      USER,
      K.userTokenAccount,
    ]);
    assert.deepEqual(
      simulation.accounts.map((account) => account?.lamports ?? null),
      ["4999995000", "2039280"],
    );
    assert.deepEqual(
      simulation.postTokenBalances?.map((balance) => balance.amount),
      ["200"],
    );
  });

  it("so a report lists no token change for it, and no closed account", async () => {
    const result = await preflightTransaction(revokeOwn(), {
      rpc: recordedRpc(recording),
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "ran",
      fromReadBefore: [
        "ownerBefore",
        "dataLengthBefore",
        "delegateBefore",
        "delegatedAmountBefore",
        "closeAuthorityBefore",
      ],
      err: null,
      changes: [
        {
          kind: "sol",
          account: "user",
          before: "5000000000",
          after: "4999995000",
          ownerBefore: SYSTEM_PROGRAM,
          ownerAfter: SYSTEM_PROGRAM,
          dataLengthBefore: 0,
          dataLengthAfter: 0,
        },
      ],
    });
  });
});

describe("re-audit A5: a slot, owner or mint that is not valid is not evidence", () => {
  const solRun = (options: {
    slot?: unknown;
    walletOwnerAfter?: string;
    walletOwnerBefore?: string;
  }) =>
    jsonRpc(
      endpoint({
        ...("slot" in options ? { slot: options.slot } : {}),
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER
              ? {
                  ...system(5_000_000_000),
                  owner: options.walletOwnerBefore ?? SYSTEM_PROGRAM,
                }
              : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER
              ? {
                  ...system(4_999_995_000),
                  owner: options.walletOwnerAfter ?? SYSTEM_PROGRAM,
                }
              : null,
          ),
          preBalances: [5_000_000_000, 0, 1],
          postBalances: [4_999_995_000, 0, 1],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
  const notUsed = async (rpc: Rpc) => {
    const result = await preflightTransaction(build([transfer()]), {
      rpc,
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
    assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
    assert.equal(result.drainPattern, false);
    assert.equal(result.simulatedAt, null);
  };

  for (const slot of [-1, 1.5, "7"]) {
    it(`a context slot of ${JSON.stringify(slot)} is refused`, () =>
      notUsed(solRun({ slot })));
  }

  it("a wallet owner after the run that is not a public key is refused", () =>
    notUsed(solRun({ walletOwnerAfter: "not a public key" })));

  it("a wallet owner in the read that is not a public key is refused", () =>
    notUsed(solRun({ walletOwnerBefore: "11111111" })));

  it("a custom Rpc's slot or owner that is not valid is refused too", async () => {
    const recorded = recordedRpc({
      accounts: { [USER]: system(5_000_000_000) as never },
      simulation: {
        err: null,
        accounts: { [USER]: system(4_999_995_000) as never },
      },
    });
    for (const change of [
      { slot: -3 },
      { slot: 2.5 },
      {
        accounts: [
          {
            lamports: "4999995000",
            owner: "not a public key",
            data: new Uint8Array(),
          },
          null,
        ],
      },
    ]) {
      await notUsed({
        ...recorded,
        simulate: async (base64, addresses) => ({
          ...(await recorded.simulate(base64, addresses)),
          ...change,
        }),
      });
    }
    await notUsed({
      ...recorded,
      getAccounts: async (addresses) =>
        addresses.map((address) =>
          address === USER
            ? { lamports: "5000000000", owner: "x", data: new Uint8Array() }
            : null,
        ),
    });
  });

  it("jsonRpc itself refuses an owner or a token balance mint that is not a public key", async () => {
    const rpc = solRun({ walletOwnerBefore: "not a public key" });
    await assert.rejects(rpc.getAccounts([USER]), {
      reason: "shape",
      message: "account: owner",
    });
    const tokenRpc = jsonRpc(
      endpoint({
        accounts: () => [],
        simulation: () => ({
          err: null,
          logs: [],
          accounts: [null],
          preBalances: [1],
          postBalances: [1],
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: "not a public key",
              owner: USER,
              uiTokenAmount: { amount: "1" },
            },
          ],
          postTokenBalances: [],
        }),
      }),
      "x",
    );
    await assert.rejects(tokenRpc.simulate("", [USER]), {
      reason: "shape",
      message: "simulateTransaction: preTokenBalances: entry",
    });
  });

  it("a token balance whose mint or owner is not a public key is refused", async () => {
    const recorded = recordedRpc({
      accounts: {
        [USER]: system(5_000_000_000) as never,
        [K.userTokenAccount]: tokenState(200, null) as never,
      },
      simulation: {
        err: null,
        accounts: {
          [USER]: system(4_999_995_000) as never,
          [K.userTokenAccount]: tokenState(195, null) as never,
        },
      },
    });
    const transaction = build([
      new web3.TransactionInstruction({
        programId: new web3.PublicKey(TOKEN_PROGRAM),
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 5, 0, 0, 0, 0, 0, 0, 0]),
      }),
    ]);
    for (const field of ["mint", "owner"] as const) {
      for (const which of ["preTokenBalances", "postTokenBalances"] as const) {
        const result = await preflightTransaction(transaction, {
          rpc: {
            ...recorded,
            simulate: async (base64, addresses) => {
              const simulation = await recorded.simulate(base64, addresses);
              return {
                ...simulation,
                [which]: (simulation[which] ?? []).map((balance) => ({
                  ...balance,
                  [field]: "not a public key",
                })),
              };
            },
          },
          user: USER,
        });
        assert.ok(result.summary.kind === "ready");
        assert.equal(
          result.summary.simulation.status,
          "not-run",
          `${which} ${field}`,
        );
      }
    }
  });
});

describe("re-audit A6: the runtime error is JSON data", () => {
  const recorded = recordedRpc({
    accounts: { [USER]: system(5_000_000_000) as never },
    simulation: {
      err: { InstructionError: [0, "Custom"] },
      accounts: { [USER]: system(5_000_000_000) as never },
    },
  });
  const withErr = (err: unknown): Rpc => ({
    ...recorded,
    simulate: async (base64, addresses) => ({
      ...(await recorded.simulate(base64, addresses)),
      err,
    }),
  });
  const run = (err: unknown) =>
    preflightTransaction(build([transfer()]), {
      rpc: withErr(err),
      user: USER,
    });

  it("a bigint error becomes its decimal string, and the report is JSON", async () => {
    for (const [err, owed] of [
      [BigInt(5), "5"],
      [
        { InstructionError: [0, { Custom: BigInt(7) }] },
        { InstructionError: [0, { Custom: "7" }] },
      ],
    ] as const) {
      const result = await run(err);
      assert.ok(result.summary.kind === "ready");
      assert.deepEqual(result.summary.simulation, {
        status: "ran",
        fromReadBefore: [
          "ownerBefore",
          "dataLengthBefore",
          "delegateBefore",
          "delegatedAmountBefore",
          "closeAuthorityBefore",
        ],
        err: owed,
        changes: [],
      });
      assert.deepEqual(result.summary.blocks, ["simulation-failed"]);
      assert.deepEqual(
        JSON.parse(JSON.stringify(result.summary)),
        result.summary,
      );
    }
  });

  it("an error that is not JSON data leaves the run unused", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const err of [
      undefined,
      () => 1,
      Symbol("x"),
      Number.NaN,
      cyclic,
      new Map(),
    ]) {
      const result = await run(err);
      assert.ok(result.summary.kind === "ready");
      assert.deepEqual(result.summary.simulation, {
        status: "not-run",
        reason: "the simulation's error is not JSON data",
      });
      assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
    }
  });
});

describe("re-audit A4: the report names no address of the wallet's", () => {
  const offline = () =>
    jsonRpc(async () => {
      throw new Error("offline");
    }, "x");
  const other = key(K.userToken2022Account);
  // A Token transfer, signed by the wallet, from one of its token accounts
  // to another.
  const between = () =>
    build([
      new web3.TransactionInstruction({
        programId: new web3.PublicKey(TOKEN_PROGRAM),
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: other, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 5, 0, 0, 0, 0, 0, 0, 0]),
      }),
    ]);

  it("(i) with no read, a wallet-signed transfer's destination is marked too", async () => {
    const result = await preflightTransaction(between(), {
      rpc: offline(),
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
    const json = JSON.stringify(result);
    assert.equal(json.includes(K.userTokenAccount), false);
    assert.equal(json.includes(K.userToken2022Account), false);
    const out = result.summary.summary.effects[0];
    assert.ok(out.kind === "token-out");
    assert.deepEqual(out.source, {
      address: "user-authorized token account 1",
    });
    assert.deepEqual(out.destination, {
      address: "user-authorized token account 2",
    });
  });

  it("(ii) an address of the wallet's inside a longer run of RPC text is scrubbed", async () => {
    const approve = build([
      new web3.TransactionInstruction({
        programId: new web3.PublicKey(TOKEN_PROGRAM),
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: false },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([4, 5, 0, 0, 0, 0, 0, 0, 0]),
      }),
    ]);
    const recorded = recordedRpc({
      accounts: {
        [USER]: system(5_000_000_000) as never,
        [K.userTokenAccount]: tokenState(9, null) as never,
      },
      simulation: {
        err: {
          [`x${USER}y`]: `z${K.userTokenAccount}z`,
          list: [`2${USER}`],
        },
        accounts: {},
      },
    });
    const ran = await preflightTransaction(approve, {
      rpc: recorded,
      user: USER,
    });
    assert.ok(ran.summary.kind === "ready");
    assert.equal(ran.summary.simulation.status, "ran");
    const failed = await preflightTransaction(approve, {
      rpc: {
        ...recorded,
        simulate: async () => {
          throw new Error(`refused: k${K.userTokenAccount}k and 9${USER}`);
        },
      },
      user: USER,
    });
    assert.ok(failed.summary.kind === "ready");
    assert.equal(failed.summary.simulation.status, "not-run");
    for (const result of [ran, failed]) {
      const json = JSON.stringify(result);
      assert.equal(json.includes(USER), false, json);
      assert.equal(json.includes(K.userTokenAccount), false, json);
    }
  });
});

describe("re-audit A2: the report says which fields come from a read", () => {
  it("a used simulation names the fields taken from the read before it", async () => {
    const result = await preflightTransaction(build([transfer()]), {
      rpc: recordedRpc({
        accounts: { [USER]: system(5_000_000_000) as never },
        simulation: {
          err: null,
          accounts: { [USER]: system(4_999_995_000) as never },
        },
      }),
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    const simulation = result.summary.simulation;
    assert.ok(simulation.status === "ran");
    assert.deepEqual(simulation.fromReadBefore, [
      "ownerBefore",
      "dataLengthBefore",
      "delegateBefore",
      "delegatedAmountBefore",
      "closeAuthorityBefore",
    ]);
  });
});

describe("hunt: the public interface refuses what it cannot use, and never throws", () => {
  const recorded = recordedRpc({
    accounts: { [USER]: system(5_000_000_000) as never },
    simulation: {
      err: null,
      accounts: { [USER]: system(4_999_995_000) as never },
    },
  });
  const sent = () => encodeBase64(build([transfer()]));

  it("a read with more or fewer accounts than asked is not used", async () => {
    for (const reshape of [
      (states: unknown[]) => states.slice(0, -1),
      (states: unknown[]) => [...states, null],
      () => [],
    ]) {
      const result = await preflight(
        {
          ...recorded,
          getAccounts: async (addresses) =>
            reshape(await recorded.getAccounts(addresses)) as never,
        },
        sent(),
        USER,
      );
      assert.ok(result.kind === "ready");
      assert.deepEqual(result.simulation, {
        status: "not-run",
        reason: "the RPC did not return the accounts asked",
      });
    }
  });

  it("account data that is not bytes is not used", async () => {
    const result = await preflight(
      {
        ...recorded,
        getAccounts: async (addresses) =>
          addresses.map((address) =>
            address === USER
              ? {
                  lamports: "5000000000",
                  owner: SYSTEM_PROGRAM,
                  data: "x".repeat(200) as never,
                }
              : null,
          ),
      },
      sent(),
      USER,
    );
    assert.ok(result.kind === "ready");
    assert.deepEqual(result.simulation, {
      status: "not-run",
      reason: "an account's data is not bytes",
    });
  });

  it("a custom Rpc's replacement blockhash that is not a hash is not kept", async () => {
    for (const replacementBlockhash of [5, "not a hash", {}]) {
      const result = await preflight(
        {
          ...recorded,
          simulate: async (base64, addresses) => ({
            ...(await recorded.simulate(base64, addresses)),
            replacementBlockhash: replacementBlockhash as never,
          }),
        },
        sent(),
        USER,
      );
      assert.ok(result.kind === "ready");
      assert.equal(result.simulation.status, "ran");
      assert.deepEqual(result.simulatedAt, { slot: 0, blockhash: null });
    }
  });

  it("an Rpc whose error cannot be read as text still gives a ready result", async () => {
    const unreadable = new Error("x");
    Object.defineProperty(unreadable, "message", {
      get() {
        throw new Error("no message");
      },
    });
    for (const thrown of [
      unreadable,
      {
        toString() {
          throw new Error("no text");
        },
      },
    ]) {
      const result = await preflight(
        {
          ...recorded,
          simulate: async () => {
            throw thrown;
          },
        },
        sent(),
        USER,
      );
      assert.ok(result.kind === "ready");
      assert.deepEqual(result.simulation, {
        status: "not-run",
        reason: "the RPC failed with an error limen cannot read",
      });
    }
  });

  it("a transaction that is not text, or not bytes, is refused", async () => {
    for (const value of [{ length: 4 }, 12345, null, undefined]) {
      assert.deepEqual(await preflight(recorded, value as never, USER), {
        kind: "malformed",
        problem: "not-base64",
      });
    }
    for (const value of ["abc", null, 5, [1, 2, 3]]) {
      assert.deepEqual(
        await preflightTransaction(value as never, {
          rpc: recorded,
          user: USER,
        }),
        {
          summary: { kind: "malformed", problem: "not-bytes" },
          drainPattern: false,
          simulatedAt: null,
        },
      );
    }
  });
});

describe("hunt: only the read before the run shows a token account is the wallet's", () => {
  it("an account the wallet owns only after the run is marked user-authorized", async () => {
    // An unknown program creates the token account; only the run's state
    // after shows the wallet owns it.
    const create = new web3.TransactionInstruction({
      programId: key(K.unknownProgram),
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        {
          pubkey: new web3.PublicKey(TOKEN_PROGRAM),
          isSigner: false,
          isWritable: false,
        },
      ],
      data: Buffer.from([1]),
    });
    const rpc = jsonRpc(
      endpoint({
        accounts: (addresses) =>
          addresses.map((address) =>
            address === USER ? system(5_000_000_000) : null,
          ),
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER ? system(4_997_955_720) : tokenState(0, null),
          ),
          preBalances: [5_000_000_000, 0, 1, 1],
          postBalances: [4_997_955_720, 2_039_280, 1, 1],
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: K.mint,
              owner: USER,
              uiTokenAmount: { amount: "0" },
            },
          ],
        }),
      }),
      "x",
    );
    const result = await preflight(rpc, encodeBase64(build([create])), USER);
    assert.ok(result.kind === "ready");
    assert.equal(result.simulation.status, "ran");
    assert.deepEqual(result.userTokenAccounts, []);
    assert.deepEqual(result.userAuthorizedTokenAccounts, [K.userTokenAccount]);
  });
});

describe("audit 9: the report JSON and the blockhash", () => {
  const offline = () =>
    jsonRpc(async () => {
      throw new Error("offline");
    }, "x");

  it("an offline token transfer the wallet signs does not name its source account", async () => {
    const result = await preflightTransaction(
      build([
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(TOKEN_PROGRAM),
          keys: [
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
            { pubkey: attacker, isSigner: false, isWritable: true },
            { pubkey: user, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([3, 5, 0, 0, 0, 0, 0, 0, 0]),
        }),
      ]),
      { rpc: offline(), user: USER },
    );
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
    const json = JSON.stringify(result);
    assert.equal(json.includes(K.userTokenAccount), false);
    assert.equal(json.includes(USER), false);
    const out = result.summary.summary.effects[0];
    assert.ok(out.kind === "token-out");
    assert.deepEqual(out.source, {
      address: "user-authorized token account 1",
    });
  });

  it("an error keyed by the wallet's address loses the address", async () => {
    const result = await preflightTransaction(build([transfer()]), {
      rpc: recordedRpc({
        accounts: { [USER]: system(5_000_000_000) as never },
        simulation: {
          err: { [USER]: "insufficient funds" },
          accounts: { [USER]: system(5_000_000_000) as never },
        },
      }),
      user: USER,
    });
    assert.equal(JSON.stringify(result).includes(USER), false);
  });

  it("keeps no replacement blockhash that is an account of the transaction, or not a hash", async () => {
    const withHash = (replacementBlockhash: string) =>
      preflightTransaction(build([transfer()]), {
        rpc: recordedRpc({
          accounts: { [USER]: system(5_000_000_000) as never },
          simulation: {
            err: null,
            accounts: { [USER]: system(4_999_995_000) as never },
            slot: 7,
            replacementBlockhash,
          },
        }),
        user: USER,
      });
    assert.deepEqual((await withHash(USER)).simulatedAt, {
      slot: 7,
      blockhash: null,
    });
    assert.deepEqual((await withHash("not a hash")).simulatedAt, {
      slot: 7,
      blockhash: null,
    });
    assert.deepEqual((await withHash(K.mint)).simulatedAt, {
      slot: 7,
      blockhash: K.mint,
    });
  });
});
