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
        context: { slot: 2 },
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
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: K.mint,
              owner: USER,
              uiTokenAmount: { amount: "9" },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: K.mint,
              owner: USER,
              uiTokenAmount: { amount: "9" },
            },
          ],
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
    // more than a tenth, so there is no sweep.
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
          preBalances: [5_000_000_000, 2_039_280, 1],
          postBalances: [4_999_995_000, 2_039_280, 1],
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
