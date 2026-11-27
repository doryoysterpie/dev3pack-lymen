import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as web3 from "@solana/web3.js";

import { decodeBase64 } from "./base64.ts";
import { encodeTransaction } from "./encode.ts";
import { parseTransaction } from "./wire.ts";

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

function roundTrip(bytes: Uint8Array): Uint8Array {
  const parsed = parseTransaction(bytes);
  assert.ok(parsed.ok);
  const { signatures, message } = parsed.transaction;
  return encodeTransaction(signatures, message);
}

describe("encodeTransaction writes back the bytes parseTransaction read", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const bytes = decodeBase64(c.transaction);
      assert.ok(bytes !== null);
      assert.deepEqual(roundTrip(bytes), bytes);
    });
  }

  it("instruction data of 200 bytes, a two-byte compact length, as web3.js writes it", () => {
    const user = new web3.PublicKey(fixture.user);
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: fixture.keys.mint,
      instructions: [
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(fixture.keys.unknownProgram),
          keys: [{ pubkey: user, isSigner: true, isWritable: true }],
          data: Buffer.alloc(200, 7),
        }),
      ],
    }).compileToV0Message();
    const bytes = new web3.VersionedTransaction(message, [
      new Uint8Array(64),
    ]).serialize();
    assert.deepEqual(roundTrip(bytes), bytes);
  });
});
