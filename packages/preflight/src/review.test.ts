// Cases from the PM's internal read of E-09, each with the answer the drain
// pattern owes. Transactions are built with @solana/web3.js and
// @solana/spl-token; every simulation is a recorded RPC answer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { decodePublicKey } from "./base58.ts";
import { encodeBase64 } from "./base64.ts";
import { preflightTransaction } from "./preflight.ts";
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
) as { readonly user: string; readonly keys: Readonly<Record<string, string>> };

const USER = fixture.user;
const K = fixture.keys;
const key = (address: string) => new web3.PublicKey(address);
const user = key(USER);
const attacker = key(K.attacker);
const tokenAccount = key(K.userTokenAccount);
const mint = key(K.mint);
const unknownProgram = key(K.unknownProgram);

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

interface TokenState {
  readonly amount: bigint;
  readonly delegate?: string;
  readonly delegated?: bigint;
  readonly closeAuthority?: string;
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest % BigInt(256));
    rest /= BigInt(256);
  }
  return out;
}

const bytes = (address: string) =>
  decodePublicKey(address) ?? new Uint8Array(32);

function token(state: TokenState): RecordedAccount {
  const data = new Uint8Array(165);
  data.set(bytes(K.mint), 0);
  data.set(bytes(USER), 32);
  data.set(u64(state.amount), 64);
  if (state.delegate !== undefined) {
    data[72] = 1;
    data.set(bytes(state.delegate), 76);
  }
  data[108] = 1;
  data.set(u64(state.delegated ?? BigInt(0)), 121);
  if (state.closeAuthority !== undefined) {
    data[129] = 1;
    data.set(bytes(state.closeAuthority), 133);
  }
  return {
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM,
    data: [encodeBase64(data), "base64"],
  };
}

const wallet = (lamports: number, owner = SYSTEM_PROGRAM, length = 0) => ({
  lamports,
  owner,
  data: [encodeBase64(new Uint8Array(length)), "base64"] as const,
});

const unknown = (accounts: web3.AccountMeta[]) =>
  new web3.TransactionInstruction({
    programId: unknownProgram,
    keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...accounts],
    data: Buffer.from([1]),
  });

const writable = (pubkey: web3.PublicKey): web3.AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});

async function drain(
  transaction: Uint8Array,
  recording: Recording,
): Promise<boolean> {
  const result = await preflightTransaction(transaction, {
    rpc: recordedRpc(recording),
  });
  assert.equal(result.summary.kind, "ready");
  return result.drainPattern;
}

const tokenRecording = (after: RecordedAccount | null): Recording => ({
  accounts: {
    [USER]: wallet(5_000_000_000),
    [K.userTokenAccount]: token({ amount: BigInt(1000) }),
  },
  simulation: {
    err: null,
    accounts: {
      [USER]: wallet(4_999_995_000),
      [K.userTokenAccount]: after,
    },
  },
});

describe("M1: a token sweep shows a drain pattern", () => {
  it("P1: all tokens out, then the account closed back to the wallet", async () => {
    const transaction = build([
      spl.createTransferCheckedInstruction(
        tokenAccount,
        mint,
        attacker,
        user,
        BigInt(1000),
        0,
      ),
      spl.createCloseAccountInstruction(tokenAccount, user, user),
    ]);
    assert.equal(await drain(transaction, tokenRecording(null)), true);
  });

  it("P1b: all but one base unit out", async () => {
    const transaction = build([
      spl.createTransferCheckedInstruction(
        tokenAccount,
        mint,
        attacker,
        user,
        BigInt(999),
        0,
      ),
    ]);
    assert.equal(
      await drain(transaction, tokenRecording(token({ amount: BigInt(1) }))),
      true,
    );
  });

  it("P2b: an unknown program empties and closes the account by a cross-program call", async () => {
    const transaction = build([
      unknown([writable(tokenAccount), writable(attacker)]),
    ]);
    assert.equal(await drain(transaction, tokenRecording(null)), true);
  });

  it("a payment that leaves a tenth of the tokens shows none", async () => {
    const transaction = build([
      spl.createTransferCheckedInstruction(
        tokenAccount,
        mint,
        attacker,
        user,
        BigInt(900),
        0,
      ),
    ]);
    assert.equal(
      await drain(transaction, tokenRecording(token({ amount: BigInt(100) }))),
      false,
    );
  });
});

describe("M2: the wallet handed to a program by a cross-program call", () => {
  it("P2: an unknown program becomes the wallet's owner", async () => {
    const transaction = build([unknown([])]);
    const recording: Recording = {
      accounts: { [USER]: wallet(5_000_000_000) },
      simulation: {
        err: null,
        accounts: { [USER]: wallet(4_999_995_000, K.unknownProgram) },
      },
    };
    assert.equal(await drain(transaction, recording), true);
  });

  it("the wallet account given data", async () => {
    const transaction = build([unknown([])]);
    const recording: Recording = {
      accounts: { [USER]: wallet(5_000_000_000) },
      simulation: {
        err: null,
        accounts: { [USER]: wallet(4_999_995_000, SYSTEM_PROGRAM, 64) },
      },
    };
    assert.equal(await drain(transaction, recording), true);
  });

  it("the wallet's SOL down only by the fee shows none", async () => {
    const transaction = build([unknown([])]);
    const recording: Recording = {
      accounts: { [USER]: wallet(5_000_000_000) },
      simulation: { err: null, accounts: { [USER]: wallet(4_999_995_000) } },
    };
    assert.equal(await drain(transaction, recording), false);
  });
});

describe("m2: control handed over by a cross-program call", () => {
  it("P2c: a close authority moved to another address", async () => {
    const transaction = build([unknown([writable(tokenAccount)])]);
    const after = token({ amount: BigInt(1000), closeAuthority: K.attacker });
    assert.equal(await drain(transaction, tokenRecording(after)), true);
  });

  it("P2d: an existing delegate's allowance raised", async () => {
    const transaction = build([unknown([writable(tokenAccount)])]);
    const recording: Recording = {
      accounts: {
        [USER]: wallet(5_000_000_000),
        [K.userTokenAccount]: token({
          amount: BigInt(1000),
          delegate: K.attacker,
          delegated: BigInt(1),
        }),
      },
      simulation: {
        err: null,
        accounts: {
          [USER]: wallet(4_999_995_000),
          [K.userTokenAccount]: token({
            amount: BigInt(1000),
            delegate: K.attacker,
            delegated: BigInt("18446744073709551615"),
          }),
        },
      },
    };
    assert.equal(await drain(transaction, recording), true);
  });

  it("an allowance lowered for the same delegate shows none", async () => {
    const transaction = build([unknown([writable(tokenAccount)])]);
    const recording: Recording = {
      accounts: {
        [USER]: wallet(5_000_000_000),
        [K.userTokenAccount]: token({
          amount: BigInt(1000),
          delegate: K.attacker,
          delegated: BigInt(500),
        }),
      },
      simulation: {
        err: null,
        accounts: {
          [USER]: wallet(4_999_995_000),
          [K.userTokenAccount]: token({
            amount: BigInt(1000),
            delegate: K.attacker,
            delegated: BigInt(100),
          }),
        },
      },
    };
    assert.equal(await drain(transaction, recording), false);
  });
});

// m1 is the owner's call (DECIDE 7): the definition does not look at where the
// SOL or tokens go. These cases pin what it does today.
describe("known false alarms, held for the owner", () => {
  const organizer = key(K.organizer);

  it("F1: the whole token balance paid to the organizer", async () => {
    const transaction = build([
      spl.createTransferCheckedInstruction(
        tokenAccount,
        mint,
        organizer,
        user,
        BigInt(1000),
        0,
      ),
    ]);
    assert.equal(
      await drain(transaction, tokenRecording(token({ amount: BigInt(0) }))),
      true,
    );
  });

  it("F2: a SOL payment to the organizer that leaves under a tenth", async () => {
    const transaction = build([
      web3.SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: organizer,
        lamports: 950_000_000,
      }),
    ]);
    const recording: Recording = {
      accounts: { [USER]: wallet(1_000_000_000) },
      simulation: { err: null, accounts: { [USER]: wallet(49_995_000) } },
    };
    assert.equal(await drain(transaction, recording), true);
  });

  it("unwrapping wrapped SOL: a token account with a balance closed to the wallet", async () => {
    const transaction = build([
      spl.createCloseAccountInstruction(tokenAccount, user, user),
    ]);
    const recording: Recording = {
      accounts: {
        [USER]: wallet(1_000_000_000),
        [K.userTokenAccount]: token({ amount: BigInt(500_000_000) }),
      },
      simulation: {
        err: null,
        accounts: { [USER]: wallet(1_502_034_280), [K.userTokenAccount]: null },
      },
    };
    assert.equal(await drain(transaction, recording), true);
  });
});
