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
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import { endpointFor, recordedEndpoint } from "../test-support/recorded.ts";
import { jsonRpc, type Fetch, type RpcEndpoint } from "./rpc.ts";

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
  return async (url, init) => {
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
      // limen asks for no account state (ruling 20a), so a test's answer
      // is given no addresses.
      result = {
        context: { slot: "slot" in answers ? answers.slot : 2 },
        value: answers.simulation([]),
      };
    }
    const id = answers.id ? answers.id(request.id, request.method) : request.id;
    return {
      ok: true,
      status: 200,
      url,
      text: JSON.stringify({ jsonrpc: "2.0", id, result }),
    };
  };
}

const transfer = () =>
  web3.SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: attacker,
    lamports: 9_500_000_000,
  });

describe("audit 7: the simulation must answer what was asked", () => {
  it("an answer that carries another request's id is not used", async () => {
    const rpc = endpointFor(
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
  // Each balance the endpoint returns must be a whole number from 0 to the
  // largest u64, written in decimal; anything else holds signing, and the
  // report still builds.
  const notWhole = [
    "unknown",
    "-1",
    "1.5",
    "01",
    "1e3",
    "18446744073709551616",
  ];

  for (const bad of notWhole) {
    it(`an answer whose pre-balance is ${JSON.stringify(bad)} is not used`, async () => {
      const rpc = endpointFor(
        endpoint({
          accounts: (addresses) =>
            addresses.map((address) =>
              address === USER ? system(5_000_000_000) : null,
            ),
          simulation: (addresses) => ({
            err: null,
            logs: [],
            accounts: addresses.map((address) =>
              address === USER ? system(1) : null,
            ),
            preBalances: [bad, "0", "1"],
            postBalances: ["1", "0", "1"],
            preTokenBalances: [],
            postTokenBalances: [],
          }),
        }),
        "x",
      );
      const result = await preflightTransaction(build([transfer()]), {
        endpoint: rpc,
        user: USER,
      });
      assert.ok(result.summary.kind === "ready");
      assert.equal(result.summary.simulation.status, "not-run");
      assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
      assert.equal(result.drainPattern, false);
    });
  }

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
      endpointFor(
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
      ),
    ).simulate(encodeBase64(build([transfer()])));

  for (const bad of refusedAmounts) {
    it(`jsonRpc refuses the simulated balance ${JSON.stringify(bad)}`, async () => {
      for (const value of [
        { preBalances: [bad, 0, 1] },
        { postBalances: [bad, 0, 1] },
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
    });
    assert.deepEqual(simulation.preBalances, [
      "5000000000",
      "18446744073709551615",
      "0",
    ]);
    assert.deepEqual(simulation.postBalances, ["4999995000", "0", "1"]);
  });
});

describe("audit 12: more writable accounts than limen watches", () => {
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
        endpoint: recordedEndpoint({
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
      reason: "an address comes from a lookup table limen could not read",
    });
    assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
  });
});

describe("audit 6: the rest of the same-run evidence", () => {
  it("a simulation that gives no balances of its own run is not used", async () => {
    const result = await preflight(
      recordedEndpoint({
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
});

describe("fix check N2: token balances come only with a token program", () => {
  it("an address behind a lookup table limen could not read, which may be a token program, leaves the run unused", async () => {
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
    const rpc = endpointFor(
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
      { endpoint: rpc, user: USER },
    );
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "not-run",
      reason: "an address comes from a lookup table limen could not read",
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
      endpoint: recordedEndpoint({
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
      err: failed,
      changes: [],
    });
    assert.deepEqual(result.summary.blocks, ["simulation-failed"]);
    assert.equal(result.drainPattern, false);
  });

  it("the same, through jsonRpc with agave's null accounts", async () => {
    const rpc = endpointFor(
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
      endpoint: rpc,
      user: USER,
    });
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "ran",
      err: failed,
      changes: [],
    });
    assert.deepEqual(result.summary.blocks, ["simulation-failed"]);
  });
});

describe("re-audit A5: a slot, owner or mint that is not valid is not evidence", () => {
  const solRun = (options: {
    slot?: unknown;
    walletOwnerAfter?: string;
    walletOwnerBefore?: string;
  }) =>
    endpointFor(
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
  const notUsed = async (rpc: RpcEndpoint) => {
    const result = await preflightTransaction(build([transfer()]), {
      endpoint: rpc,
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

  it("jsonRpc itself refuses an account owner that is not a public key", async () => {
    const rpc = jsonRpc(solRun({ walletOwnerBefore: "not a public key" }));
    await assert.rejects(rpc.getAccounts([USER]), {
      reason: "shape",
      message: "account: owner",
    });
  });
});

describe("re-audit A4: the report names no address of the wallet's", () => {
  const offline = () =>
    endpointFor(async () => {
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
      endpoint: offline(),
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
    const recorded = recordedEndpoint({
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
      endpoint: recorded,
      user: USER,
    });
    assert.ok(ran.summary.kind === "ready");
    assert.equal(ran.summary.simulation.status, "ran");
    // The endpoint answers the simulation with a JSON-RPC error whose text
    // holds both addresses inside longer runs.
    const refusing: Fetch = async (url, init) => {
      const request = JSON.parse(init.body) as { id: number; method: string };
      if (request.method !== "simulateTransaction") {
        return recorded.fetch(url, init);
      }
      return {
        ok: true,
        status: 200,
        url,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32002,
            message: `refused: k${K.userTokenAccount}k and 9${USER}`,
          },
        }),
      };
    };
    const failed = await preflightTransaction(approve, {
      endpoint: endpointFor(refusing, "x"),
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

describe("hunt: the public interface refuses what it cannot use, and never throws", () => {
  const recorded = recordedEndpoint({
    accounts: { [USER]: system(5_000_000_000) as never },
    simulation: {
      err: null,
      accounts: { [USER]: system(4_999_995_000) as never },
    },
  });
  const sent = () => encodeBase64(build([transfer()]));
  const solRun = (
    accounts: (addresses: string[]) => unknown[],
    replacementBlockhash?: unknown,
  ) =>
    endpointFor(
      endpoint({
        accounts,
        simulation: (addresses) => ({
          err: null,
          logs: [],
          accounts: addresses.map((address) =>
            address === USER ? system(4_999_995_000) : null,
          ),
          preBalances: [5_000_000_000, 0, 1],
          postBalances: [4_999_995_000, 0, 1],
          preTokenBalances: [],
          postTokenBalances: [],
          ...(replacementBlockhash === undefined
            ? {}
            : { replacementBlockhash: { blockhash: replacementBlockhash } }),
        }),
      }),
      "x",
    );
  const wallet = (addresses: string[]) =>
    addresses.map((address) =>
      address === USER ? system(5_000_000_000) : null,
    );

  it("a replacement blockhash that is not a hash is not kept", async () => {
    for (const replacementBlockhash of [5, "not a hash", {}]) {
      const result = await preflight(
        solRun(wallet, replacementBlockhash),
        sent(),
        USER,
      );
      assert.ok(result.kind === "ready");
      assert.equal(result.simulation.status, "ran");
      assert.deepEqual(result.simulatedAt, { slot: 2, blockhash: null });
    }
  });

  it("a fetch that throws something unreadable still gives a ready result", async () => {
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
        endpointFor(async () => {
          throw thrown;
        }, "x"),
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
          endpoint: recorded,
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

describe("re-audit 2, item 9: any address limen cannot resolve holds signing", () => {
  it("a read-only address behind a lookup table limen could not read leaves the run unused", async () => {
    const table = new web3.AddressLookupTableAccount({
      key: web3.PublicKey.unique(),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [attacker],
      },
    });
    const call = new web3.TransactionInstruction({
      programId: key(K.unknownProgram),
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: attacker, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: K.mint,
      instructions: [call],
    }).compileToV0Message([table]);
    assert.equal(message.addressTableLookups.length, 1);
    assert.deepEqual(message.addressTableLookups[0].writableIndexes, []);
    const result = await preflightTransaction(
      new web3.VersionedTransaction(message, [new Uint8Array(64)]).serialize(),
      {
        endpoint: recordedEndpoint({
          accounts: { [USER]: system(5_000_000_000) as never },
          simulation: {
            err: null,
            accounts: { [USER]: system(4_999_995_000) as never },
          },
        }),
        user: USER,
      },
    );
    assert.ok(result.summary.kind === "ready");
    assert.deepEqual(result.summary.simulation, {
      status: "not-run",
      reason: "an address comes from a lookup table limen could not read",
    });
    assert.deepEqual(result.summary.blocks, ["simulation-not-run"]);
  });
});

describe("audit 9: the report JSON and the blockhash", () => {
  const offline = () =>
    endpointFor(async () => {
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
      { endpoint: offline(), user: USER },
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
      endpoint: recordedEndpoint({
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
    const rpcWith = (replacementBlockhash: string) =>
      recordedEndpoint({
        accounts: { [USER]: system(5_000_000_000) as never },
        simulation: {
          err: null,
          accounts: { [USER]: system(4_999_995_000) as never },
          slot: 7,
          replacementBlockhash,
        },
      });
    // The app's Preflight keeps a checked blockhash.
    const withHash = (replacementBlockhash: string) =>
      preflight(
        rpcWith(replacementBlockhash),
        encodeBase64(build([transfer()])),
        USER,
      ).then((result) => {
        assert.ok(result.kind === "ready");
        return result;
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

  it("re-audit A4 (iii): the server output keeps no blockhash from the RPC", async () => {
    const result = await preflightTransaction(build([transfer()]), {
      endpoint: recordedEndpoint({
        accounts: { [USER]: system(5_000_000_000) as never },
        simulation: {
          err: null,
          accounts: { [USER]: system(4_999_995_000) as never },
          slot: 7,
          replacementBlockhash: K.mint,
        },
      }),
      user: USER,
    });
    assert.deepEqual(result.simulatedAt, { slot: 7 });
    assert.equal(JSON.stringify(result).includes(K.mint), false);
  });
});

describe("ruling 20a, item 2: from a failed run limen uses nothing but its error", () => {
  const failed = { InstructionError: [0, { Custom: 1 }] };
  const failedRun = (value: Json) =>
    endpointFor(
      endpoint({
        accounts: () => [],
        simulation: () => ({ err: failed, logs: [], ...value }),
      }),
      "x",
    );

  for (const [name, value] of [
    ["no balances", {}],
    [
      "balances that are not amounts",
      { preBalances: ["x"], postBalances: [-1] },
    ],
    ["balances of another length", { preBalances: [1], postBalances: [1] }],
    [
      "a replacement blockhash",
      {
        preBalances: [1, 0, 1],
        postBalances: [1, 0, 1],
        replacementBlockhash: { blockhash: K.mint, lastValidBlockHeight: 0 },
      },
    ],
  ] as const) {
    it(`a failed run with ${name} reports its error, no change and no blockhash`, async () => {
      const result = await preflight(
        failedRun(value as Json),
        encodeBase64(build([transfer()])),
        USER,
      );
      assert.ok(result.kind === "ready");
      assert.deepEqual(result.simulation, {
        status: "ran",
        err: failed,
        changes: [],
      });
      assert.deepEqual(result.simulatedAt, { slot: 2, blockhash: null });
      assert.deepEqual(result.blocks, ["simulation-failed"]);
    });
  }
});
