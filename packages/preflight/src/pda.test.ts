// pda.ts against the libraries the fixtures are built with: SHA-256 against
// node:crypto, the point test and the derivation against @solana/web3.js
// 1.99.0, and an associated token account's address against
// @solana/spl-token 0.4.15, on random keys.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { findProgramAddress, isOnCurve, sha256 } from "./pda.ts";
import { ASSOCIATED_TOKEN_PROGRAM } from "./programs.ts";

describe("pda.ts", () => {
  it("hashes as SHA-256 does, at every length across two blocks", () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = randomBytes(length);
      assert.equal(
        Buffer.from(sha256(bytes)).toString("hex"),
        createHash("sha256").update(bytes).digest("hex"),
        String(length),
      );
    }
  });

  it("tests a point as web3.js does", () => {
    let on = 0;
    for (let round = 0; round < 400; round += 1) {
      const bytes = randomBytes(32);
      const owed = web3.PublicKey.isOnCurve(bytes);
      assert.equal(isOnCurve(bytes), owed, bytes.toString("hex"));
      if (owed) on += 1;
    }
    // Keypairs are always points.
    for (let round = 0; round < 50; round += 1) {
      assert.equal(
        isOnCurve(web3.Keypair.generate().publicKey.toBytes()),
        true,
      );
    }
    assert.ok(on > 50 && on < 350, String(on));
  });

  it("derives addresses as web3.js does", () => {
    for (let round = 0; round < 100; round += 1) {
      const seeds = [web3.PublicKey.unique(), web3.PublicKey.unique()];
      const program = web3.PublicKey.unique();
      const [owed] = web3.PublicKey.findProgramAddressSync(
        seeds.map((seed) => seed.toBuffer()),
        program,
      );
      assert.equal(
        findProgramAddress(
          seeds.map((seed) => seed.toBase58()),
          program.toBase58(),
        ),
        owed.toBase58(),
      );
    }
  });

  it("derives an associated token account as spl-token does, for both token programs", () => {
    for (const tokenProgram of [
      spl.TOKEN_PROGRAM_ID,
      spl.TOKEN_2022_PROGRAM_ID,
    ]) {
      for (let round = 0; round < 50; round += 1) {
        const wallet = web3.Keypair.generate().publicKey;
        const mint = web3.PublicKey.unique();
        assert.equal(
          findProgramAddress(
            [wallet.toBase58(), tokenProgram.toBase58(), mint.toBase58()],
            ASSOCIATED_TOKEN_PROGRAM,
          ),
          spl
            .getAssociatedTokenAddressSync(mint, wallet, false, tokenProgram)
            .toBase58(),
        );
      }
    }
  });

  it("derives nothing from text that is not a public key", () => {
    assert.equal(findProgramAddress(["x"], ASSOCIATED_TOKEN_PROGRAM), null);
  });
});
