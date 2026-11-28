// The audit of E-09 at ac1ce67: anything compared against or described from an
// absent value yields "limen could not tell", never "different" or "another".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import {
  drainPattern,
  encodeBase64,
  preflight,
  signingAllowed,
  toReport,
  type RpcEndpoint,
} from "@limen/preflight";

import { encodeTransaction } from "../../../../packages/preflight/src/encode.ts";
import {
  edited,
  once,
} from "../../../../packages/preflight/test-support/build.ts";
import {
  clean as cleanWithTable,
  loadedV0,
} from "../../../../packages/preflight/test-support/audit.ts";
import { endpointFor } from "../../../../packages/preflight/test-support/recorded.ts";

import { transactionCardText } from "./card-text.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Readonly<Record<string, string>>;
};

const USER = fixture.user;
const {
  attacker: ATTACKER,
  userTokenAccount: ACCOUNT,
  mint: MINT,
  lookupTable: TABLE,
  unknownProgram: UNKNOWN_PROGRAM,
} = fixture.keys;
const LINK = "https://pay.example/solana-pay?order=7";

const user = new web3.PublicKey(USER);
const account = new web3.PublicKey(ACCOUNT);
const attacker = new web3.PublicKey(ATTACKER);
const mint = new web3.PublicKey(MINT);
const SPL = spl.TOKEN_PROGRAM_ID;
const T22 = spl.TOKEN_2022_PROGRAM_ID;

const offline: RpcEndpoint = endpointFor(async () => {
  throw new Error("offline");
}, "https://devnet.example");

describe("the audit of ac1ce67, Major 1: an unresolved delegate or close destination on the card", () => {
  const tableKey = new web3.PublicKey(TABLE);
  const table = new web3.AddressLookupTableAccount({
    key: tableKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [mint, attacker],
    },
  });
  const v0 = (...instructions: web3.TransactionInstruction[]) => {
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: MINT,
      instructions,
    }).compileToV0Message([table]);
    return Buffer.from(
      new web3.VersionedTransaction(message).serialize(),
    ).toString("base64");
  };

  for (const [name, instruction] of [
    [
      "a Token approval",
      spl.createApproveInstruction(account, attacker, user, 5, [], SPL),
    ],
    [
      "a Token-2022 checked approval",
      spl.createApproveCheckedInstruction(
        account,
        mint,
        attacker,
        user,
        5,
        6,
        [],
        T22,
      ),
    ],
    [
      "a Token close",
      spl.createCloseAccountInstruction(account, attacker, user, [], SPL),
    ],
  ] as const) {
    it(`names the unread lookup table entry and sets no drainPattern for ${name}`, async () => {
      const sent = v0(instruction);
      const result = await preflight(offline, sent, USER);
      assert.equal(result.kind, "ready");
      assert.equal(drainPattern(toReport(result)), false);
      assert.equal(signingAllowed(result, sent), false);
      const card = transactionCardText(LINK, null, result);
      assert.equal(card.tone, "flagged");
      assert.equal(
        card.status,
        `limen flags this transaction: an instruction asks your wallet to give control of tokens or accounts to an address in lookup table ${TABLE} at index 1 that limen could not read, so limen could not tell whether that address is your wallet.`,
      );
      assert.doesNotMatch(card.status, /\banother\b|\bdifferent\b/);
    });
  }

  it("includes the unread lookup-table control warning on the fallback card", async () => {
    const unknown = new web3.TransactionInstruction({
      programId: new web3.PublicKey(UNKNOWN_PROGRAM),
      keys: [{ pubkey: user, isSigner: true, isWritable: true }],
      data: Buffer.from([1]),
    });
    const sent = v0(
      spl.createCloseAccountInstruction(account, attacker, user, [], SPL),
      unknown,
    );
    const result = await preflight(offline, sent, USER);
    const card = transactionCardText(LINK, null, result);
    assert.equal(
      card.status,
      `limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. No simulation result is used, so no balance change is shown. An instruction asks your wallet to give control of tokens or accounts to an address in lookup table ${TABLE} at index 1 that limen could not read, so limen could not tell whether that address is your wallet.`,
    );
  });

  it("does not say limen could not read a lookup table that loadTables read before a failed run", async () => {
    const result = await preflight(
      edited(cleanWithTable(), "simulateTransaction", (text) =>
        once(text, '"err":null', '"err":"InsufficientFundsForFee"'),
      ),
      loadedV0.transaction,
      USER,
    );
    assert.equal(result.kind, "ready");
    assert.equal(drainPattern(toReport(result)), false);
    const card = transactionCardText(LINK, null, result);
    assert.equal(
      card.status,
      `limen flags this transaction: an instruction asks your wallet to give control of tokens or accounts to an address in lookup table ${TABLE} at index 1 that limen does not show, so limen could not tell whether that address is your wallet. The simulation failed, so signed now it would most likely fail.`,
    );
    assert.doesNotMatch(
      card.status,
      /\banother\b|\bdifferent\b|could not read/,
    );
  });

  it("swept: instructions whose actor sits in an unread lookup table say limen could not tell, never another or other than", async () => {
    const assignData = new Uint8Array(36);
    assignData[0] = 1; // System Assign
    assignData.set(new web3.PublicKey(UNKNOWN_PROGRAM).toBytes(), 4);

    const seed = new TextEncoder().encode("vault");
    const withSeedData = new Uint8Array(4 + 8 + 8 + seed.length + 32);
    const view = new DataView(withSeedData.buffer);
    view.setUint32(0, 11, true); // System TransferWithSeed
    view.setBigUint64(4, BigInt(100), true);
    view.setBigUint64(12, BigInt(seed.length), true);
    withSeedData.set(seed, 20);
    withSeedData.set(
      new web3.PublicKey(UNKNOWN_PROGRAM).toBytes(),
      20 + seed.length,
    );

    const transferData = new Uint8Array(12);
    new DataView(transferData.buffer).setUint32(0, 2, true);

    const approveData = Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0, 0);

    // staticKeys: 0 = user, 1 = System, 2 = Token, 3 = account; index 4 is lookup table index 0.
    const raw = encodeBase64(
      encodeTransaction([new Uint8Array(64)], {
        version: 0,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 2,
        },
        staticKeys: [
          USER,
          web3.SystemProgram.programId.toBase58(),
          SPL.toBase58(),
          ACCOUNT,
        ],
        recentBlockhash: MINT,
        instructions: [
          { programIdIndex: 1, accountIndexes: [4], data: assignData },
          {
            programIdIndex: 1,
            accountIndexes: [3, 4, 3],
            data: withSeedData,
          },
          { programIdIndex: 1, accountIndexes: [4, 3], data: transferData },
          { programIdIndex: 2, accountIndexes: [3, 3, 4], data: approveData },
        ],
        lookups: [{ table: TABLE, writableIndexes: [0], readonlyIndexes: [] }],
      }),
    );
    const result = await preflight(offline, raw, USER);
    const card = transactionCardText(LINK, null, result);
    const otherRows = card.rows
      .filter((row) => row.label === "Also in the transaction")
      .map((row) => row.value);
    assert.equal(otherRows.length, 4);
    for (const value of otherRows) {
      assert.match(value, /limen could not tell/);
      assert.doesNotMatch(
        value,
        /\banother\b|\bdifferent\b|\bother than\b|\bdoes not name\b/,
      );
    }
  });
});
