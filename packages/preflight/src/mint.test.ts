// m7: a MintTo the wallet signs as mint authority. Layout from
// solana-program/token 38de8d1, interface/src/instruction.rs: MintTo is tag 7
// with a u64 amount, MintToChecked tag 14 with a u64 amount and u8 decimals;
// the accounts are the mint, the account to mint to, and the mint authority,
// then any multisig signers. Each transaction is built with
// @solana/spl-token.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

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
const mint = key(K.mint);
const destination = key(K.userToken2022Account);

function summary(instruction: web3.TransactionInstruction) {
  const message = new web3.TransactionMessage({
    payerKey: user,
    recentBlockhash: K.mint,
    instructions: [instruction],
  }).compileToLegacyMessage();
  const signatures = Array.from(
    { length: message.header.numRequiredSignatures },
    () => new Uint8Array(64),
  );
  const parsed = parseTransaction(
    new web3.VersionedTransaction(message, signatures).serialize(),
  );
  assert.ok(parsed.ok);
  return summarizeTransaction(parsed.transaction, new Map());
}

describe("m7: tokens minted with the wallet's mint authority", () => {
  it("the internal read's case: 10^15 base units minted", () => {
    const got = summary(
      spl.createMintToInstruction(
        mint,
        destination,
        user,
        BigInt(10) ** BigInt(15),
      ),
    );
    assert.deepEqual(got.effects, [
      {
        kind: "tokens-minted",
        instruction: 0,
        program: "token",
        mint: { address: K.mint },
        destination: { address: K.userToken2022Account },
        amount: "1000000000000000",
        decimals: null,
      },
    ]);
    assert.deepEqual(got.others, []);
  });

  it("MintToChecked on Token-2022, with its decimals", () => {
    const got = summary(
      spl.createMintToCheckedInstruction(
        mint,
        destination,
        user,
        BigInt(2_500_000),
        6,
        [],
        spl.TOKEN_2022_PROGRAM_ID,
      ),
    );
    assert.deepEqual(got.effects, [
      {
        kind: "tokens-minted",
        instruction: 0,
        program: "token-2022",
        mint: { address: K.mint },
        destination: { address: K.userToken2022Account },
        amount: "2500000",
        decimals: 6,
      },
    ]);
  });

  // Audit finding 4: a multisig member is not the multisig, which is the
  // mint authority (token 38de8d1, processor.rs, validate_owner).
  it("the wallet as one signer of a multisig mint authority: not the wallet's effect", () => {
    const got = summary(
      spl.createMintToInstruction(mint, destination, attacker, BigInt(1), [
        user,
      ]),
    );
    assert.deepEqual(got.effects, []);
    assert.deepEqual(got.others, [{ instruction: 0, kind: "token-mint-to" }]);
  });

  it("another address's mint authority: not the wallet's effect", () => {
    const got = summary(
      spl.createMintToInstruction(mint, destination, attacker, BigInt(1)),
    );
    assert.deepEqual(got.effects, []);
    assert.deepEqual(got.others, [{ instruction: 0, kind: "token-mint-to" }]);
  });

  it("m8: tag 7 with no amount is not decoded", () => {
    const instruction = spl.createMintToInstruction(
      mint,
      destination,
      user,
      BigInt(1),
    );
    instruction.data = Buffer.from([7]);
    assert.deepEqual(summary(instruction).undecoded, [
      {
        instruction: 0,
        programId: spl.TOKEN_PROGRAM_ID.toBase58(),
        reason: "unexpected-data",
      },
    ]);
  });
});
