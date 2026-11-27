// m13: a request that leaves the fee payer unset. Each transaction is built
// with @solana/web3.js twice from the same instructions: once with the zero
// key as fee payer, as the Solana Pay specification lets an application send
// it, and once with the user's wallet as fee payer, as the wallet signs it.
// limen's rebuild of the first owes the summary of the second.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import type { LookupTables } from "./accounts.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import {
  readUnsetFeePayer,
  UNSET_FEE_PAYER,
  withFeePayer,
} from "./fee-payer.ts";
import {
  forSigning,
  preflight,
  preflightTransaction,
  signingAllowed,
} from "./preflight.ts";
import { SYSTEM_PROGRAM } from "./programs.ts";
import { recordedRpc, type Recording } from "./recorded.ts";
import type { Rpc } from "./rpc.ts";
import { summarizeTransaction } from "./summary.ts";
import { parseTransaction } from "./wire.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as { readonly user: string; readonly keys: Readonly<Record<string, string>> };

const K = fixture.keys;
const key = (address: string) => new web3.PublicKey(address);
const user = key(fixture.user);
const attacker = key(K.attacker);
const unknownProgram = key(K.unknownProgram);
const table = new web3.AddressLookupTableAccount({
  key: key(K.lookupTable),
  state: {
    deactivationSlot: BigInt("18446744073709551615"),
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    addresses: [attacker],
  },
});
const tables: LookupTables = new Map([[K.lookupTable, [K.attacker]]]);

function build(
  payer: web3.PublicKey,
  instructions: web3.TransactionInstruction[],
  lookup = false,
): Uint8Array {
  const draft = new web3.TransactionMessage({
    payerKey: payer,
    recentBlockhash: K.mint,
    instructions,
  });
  const message = lookup
    ? draft.compileToV0Message([table])
    : draft.compileToLegacyMessage();
  const signatures = Array.from(
    { length: message.header.numRequiredSignatures },
    () => new Uint8Array(64),
  );
  return new web3.VersionedTransaction(message, signatures).serialize();
}

function rebuilt(unset: Uint8Array): Uint8Array {
  const read = readUnsetFeePayer(unset);
  assert.ok(read !== null);
  return withFeePayer(read, fixture.user);
}

function summary(bytes: Uint8Array) {
  const parsed = parseTransaction(bytes);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return summarizeTransaction(parsed.transaction, tables);
}

const unsetPayer = key(UNSET_FEE_PAYER);

const transfer = () =>
  web3.SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: attacker,
    lamports: 1_000_000_000,
  });

describe("m13: the fee payer left unset", () => {
  it("is refused by the full parser, as the zero key runs the transfer", () => {
    assert.deepEqual(parseTransaction(build(unsetPayer, [transfer()])), {
      ok: false,
      problem: "bad-program-index",
    });
  });

  it("a SOL transfer: rebuilt with the wallet as fee payer, byte for byte as web3.js compiles it", () => {
    const got = rebuilt(build(unsetPayer, [transfer()]));
    const owed = build(user, [transfer()]);
    assert.deepEqual(summary(got), summary(owed));
    assert.deepEqual(got, owed);
  });

  it("a v0 transaction: the zero key dropped and the lookup index moved down by one", () => {
    const call = () =>
      new web3.TransactionInstruction({
        programId: unknownProgram,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([1]),
      });
    const unset = build(unsetPayer, [call()], true);
    const read = readUnsetFeePayer(unset);
    assert.ok(read !== null);
    assert.equal(read.message.staticKeys.length, 3);
    assert.deepEqual(read.message.instructions[0].accountIndexes, [1, 3]);
    const got = withFeePayer(read, fixture.user);
    const owed = build(user, [call()], true);
    assert.deepEqual(summary(got), summary(owed));
    assert.deepEqual(got, owed);
  });

  it("a request that does not name the wallet: the wallet added as fee payer", () => {
    const memo = () =>
      new web3.TransactionInstruction({
        programId: key("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        keys: [],
        data: Buffer.from("order 7"),
      });
    const got = rebuilt(build(unsetPayer, [memo()]));
    assert.deepEqual(summary(got), summary(build(user, [memo()])));
  });

  it("the zero key named as an account keeps a signer's role, so another signature is missing", () => {
    const create = () =>
      spl.createAssociatedTokenAccountInstruction(
        user,
        spl.getAssociatedTokenAddressSync(key(K.mint), attacker),
        attacker,
        key(K.mint),
      );
    const got = summary(rebuilt(build(unsetPayer, [create()])));
    assert.deepEqual(got.signers, {
      feePayer: "user",
      others: [{ address: UNSET_FEE_PAYER, signed: false }],
      unsigned: true,
    });
  });

  it("is not read as unset when a signature is filled in", () => {
    const signed = build(unsetPayer, [transfer()]);
    signed[1] = 7;
    assert.equal(readUnsetFeePayer(signed), null);
  });

  it("is not read as unset when the fee payer is a wallet", () => {
    assert.equal(readUnsetFeePayer(build(attacker, [transfer()])), null);
  });
});

describe("m13: the pre-flight of a request with the fee payer unset", () => {
  const wallet = (lamports: number) => ({
    lamports,
    owner: SYSTEM_PROGRAM,
    data: ["", "base64"] as const,
  });
  const sweep: Recording = {
    accounts: { [fixture.user]: wallet(1_050_000_000) },
    simulation: {
      err: null,
      accounts: { [fixture.user]: wallet(49_995_000) },
    },
  };
  const unset = () => encodeBase64(build(unsetPayer, [transfer()]));

  it("treats the wallet as fee payer, and simulates and signs the rebuilt transaction", async () => {
    const simulated: string[] = [];
    const recorded = recordedRpc(sweep);
    const rpc: Rpc = {
      ...recorded,
      simulate: (base64, addresses) => {
        simulated.push(base64);
        return recorded.simulate(base64, addresses);
      },
    };
    const result = await preflight(rpc, unset(), fixture.user);
    assert.ok(result.kind === "ready");
    const owed = encodeBase64(build(user, [transfer()]));
    assert.equal(result.feePayerSet, true);
    assert.equal(result.base64, owed);
    assert.deepEqual(simulated, [owed]);
    assert.deepEqual(result.summary.effects, [
      {
        kind: "sol-out",
        instruction: 0,
        to: { address: K.attacker },
        lamports: "1000000000",
        reason: "transfer",
      },
    ]);
    assert.deepEqual(result.blocks, []);
    assert.equal(signingAllowed(result, unset()), false);
    assert.equal(signingAllowed(result, owed), true);
    const signing = decodeBase64(forSigning(result, K.attacker));
    assert.ok(signing !== null);
    const parsed = parseTransaction(signing);
    assert.ok(parsed.ok);
    assert.equal(parsed.transaction.message.staticKeys[0], fixture.user);
    assert.equal(parsed.transaction.message.recentBlockhash, K.attacker);
  });

  it("finds the drain pattern in the rebuilt transaction", async () => {
    const result = await preflightTransaction(build(unsetPayer, [transfer()]), {
      rpc: recordedRpc(sweep),
      user: fixture.user,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.feePayerSet, true);
    assert.equal(result.drainPattern, true);
  });

  it("stops, with no drain pattern, when no wallet is given to set", async () => {
    const result = await preflightTransaction(build(unsetPayer, [transfer()]), {
      rpc: recordedRpc(sweep),
    });
    assert.deepEqual(result.summary, { kind: "fee-payer-not-set" });
    assert.equal(result.drainPattern, false);
  });

  it("leaves a request that sets the wallet as fee payer as it was sent", async () => {
    const sent = encodeBase64(build(user, [transfer()]));
    const result = await preflight(recordedRpc(sweep), sent, fixture.user);
    assert.ok(result.kind === "ready");
    assert.equal(result.feePayerSet, false);
    assert.equal(result.base64, sent);
  });
});
