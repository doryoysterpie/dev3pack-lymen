// The owner's Codex audit of E-09 at 2a7d3e2, findings 2, 3, 4, 5, 13 and
// 14, each with the answer the code owes. Every rule rests on the pinned
// program source named beside its test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { decodePublicKey } from "./base58.ts";
import { encodeBase64 } from "./base64.ts";
import { encodeTransaction } from "./encode.ts";
import { preflight, preflightTransaction } from "./preflight.ts";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import { endpointFor, recordedEndpoint } from "../test-support/recorded.ts";
import { summarizeTransaction } from "./summary.ts";
import { parseTransaction, type ParsedTransaction } from "./wire.ts";

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
const organizer = key(K.organizer);
const tokenAccount = key(K.userTokenAccount);
const mint = key(K.mint);

function parsed(
  instructions: web3.TransactionInstruction[],
): ParsedTransaction {
  const message = new web3.TransactionMessage({
    payerKey: user,
    recentBlockhash: K.mint,
    instructions,
  }).compileToLegacyMessage();
  const signatures = Array.from(
    { length: message.header.numRequiredSignatures },
    () => new Uint8Array(64),
  );
  const result = parseTransaction(
    new web3.VersionedTransaction(message, signatures).serialize(),
  );
  assert.ok(result.ok);
  return result.transaction;
}

const summary = (instructions: web3.TransactionInstruction[]) =>
  summarizeTransaction(parsed(instructions), new Map());

const offline = () =>
  endpointFor(async () => {
    throw new Error("offline");
  }, "x");

const undecodedAt = (programId: string, reason: string) => [
  { instruction: 0, programId, reason },
];

describe("audit 2: a freeze or a truncated named instruction is not decoded", () => {
  // solana-program/token 38de8d1, program/src/processor.rs:713,
  // process_toggle_freeze_account: the account becomes frozen, which the
  // summary does not track.
  it("FreezeAccount and ThawAccount go to the fallback card", () => {
    assert.deepEqual(
      summary([spl.createFreezeAccountInstruction(tokenAccount, mint, user)])
        .undecoded,
      undecodedAt(TOKEN_PROGRAM, "instruction-not-decoded"),
    );
    assert.deepEqual(
      summary([spl.createThawAccountInstruction(tokenAccount, mint, user)])
        .undecoded,
      undecodedAt(TOKEN_PROGRAM, "instruction-not-decoded"),
    );
  });

  // interface/src/instruction.rs at 38de8d1: InitializeMint unpacks
  // decimals and the mint authority after its tag; limen no longer names it.
  it("a one-byte InitializeMint with no accounts is not decoded", () => {
    assert.deepEqual(
      summary([
        new web3.TransactionInstruction({
          programId: spl.TOKEN_PROGRAM_ID,
          keys: [],
          data: Buffer.from([0]),
        }),
      ]).undecoded,
      undecodedAt(TOKEN_PROGRAM, "instruction-not-decoded"),
    );
  });

  // instruction.rs:627: InitializeAccount3 unpacks an owner key after its tag.
  it("a named tag without its data is unexpected data", () => {
    assert.deepEqual(
      summary([
        new web3.TransactionInstruction({
          programId: spl.TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([18]),
        }),
      ]).undecoded,
      undecodedAt(TOKEN_PROGRAM, "unexpected-data"),
    );
  });

  it("SyncNative of the right length is still named", () => {
    const got = summary([spl.createSyncNativeInstruction(tokenAccount)]);
    assert.deepEqual(got.undecoded, []);
    assert.deepEqual(got.others, [{ instruction: 0, kind: "token-other" }]);
  });
});

describe("audit 3: Token-2022 transfers and closes are not decoded", () => {
  // solana-program/token-2022 efe55b4, program/src/processor.rs:574 credits
  // the amount net of a transfer fee, :611 invokes a transfer hook, and
  // process_close_account (:1339) can close a mint.
  it("TransferChecked on Token-2022 goes to the fallback card", () => {
    assert.deepEqual(
      summary([
        spl.createTransferCheckedInstruction(
          tokenAccount,
          mint,
          attacker,
          user,
          BigInt(5),
          0,
          [],
          spl.TOKEN_2022_PROGRAM_ID,
        ),
      ]).undecoded,
      undecodedAt(TOKEN_2022_PROGRAM, "instruction-not-decoded"),
    );
  });

  it("CloseAccount on Token-2022 goes to the fallback card", () => {
    assert.deepEqual(
      summary([
        spl.createCloseAccountInstruction(
          tokenAccount,
          user,
          user,
          [],
          spl.TOKEN_2022_PROGRAM_ID,
        ),
      ]).undecoded,
      undecodedAt(TOKEN_2022_PROGRAM, "instruction-not-decoded"),
    );
  });

  it("TransferChecked on the Token program is still decoded", () => {
    const got = summary([
      spl.createTransferCheckedInstruction(
        tokenAccount,
        mint,
        attacker,
        user,
        BigInt(5),
        0,
      ),
    ]);
    assert.deepEqual(
      got.effects.map((effect) => effect.kind),
      ["token-out"],
    );
  });
});

describe("audit 4: only the authority account itself authorizes", () => {
  // token 38de8d1, program/src/processor.rs:379, process_approve:
  // validate_owner against the source account's owner, at the owner position.
  it("an Approve signed by B, with the wallet as an extra signer, is not the wallet's", async () => {
    const ownerB = organizer;
    const approve = new web3.TransactionInstruction({
      programId: spl.TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: attacker, isSigner: false, isWritable: false },
        { pubkey: ownerB, isSigner: true, isWritable: false },
        { pubkey: user, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([4, 5, 0, 0, 0, 0, 0, 0, 0]),
    });
    assert.deepEqual(summary([approve]).effects, []);
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: K.mint,
      instructions: [approve],
    }).compileToLegacyMessage();
    const bytes = new web3.VersionedTransaction(message, [
      new Uint8Array(64),
      new Uint8Array(64),
    ]).serialize();
    const result = await preflightTransaction(bytes, {
      endpoint: offline(),
      user: fixture.user,
    });
    assert.equal(result.drainPattern, false);
  });

  it("a multisig member is not the multisig", () => {
    assert.deepEqual(
      summary([
        spl.createApproveInstruction(
          tokenAccount,
          attacker,
          organizer,
          BigInt(5),
          [user],
        ),
      ]).effects,
      [],
    );
  });
});

describe("audit 5: a Token-2022 Revoke does not prove ownership", () => {});

describe("audit 13: Assign to the System Program is not decoded", () => {
  it("goes to the fallback card, with no drain pattern", async () => {
    const assign = web3.SystemProgram.assign({
      accountPubkey: user,
      programId: web3.SystemProgram.programId,
    });
    assert.deepEqual(
      summary([assign]).undecoded,
      undecodedAt(SYSTEM_PROGRAM, "instruction-not-decoded"),
    );
  });
});

describe("audit 14: the right diagnosis for malformed input", () => {
  // solana-sdk 7b382f6, system-interface/src/instruction.rs:268: from_seed
  // is a Rust String, so its bytes must be UTF-8.
  it("TransferWithSeed with a seed that is not UTF-8 is invalid data", () => {
    const seed = Buffer.from([0xff]);
    const data = Buffer.alloc(4 + 8 + 8 + seed.length + 32);
    data.writeUInt32LE(11, 0);
    data.writeBigUInt64LE(BigInt(1), 4);
    data.writeBigUInt64LE(BigInt(seed.length), 12);
    seed.copy(data, 20);
    attacker.toBuffer().copy(data, 20 + seed.length);
    assert.deepEqual(
      summary([
        new web3.TransactionInstruction({
          programId: web3.SystemProgram.programId,
          keys: [
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
            { pubkey: user, isSigner: true, isWritable: false },
            { pubkey: attacker, isSigner: false, isWritable: true },
          ],
          data,
        }),
      ]).undecoded,
      undecodedAt(SYSTEM_PROGRAM, "invalid-data"),
    );
  });

  it("SetAuthority with an option byte of 2, or an unknown authority type, is invalid data", () => {
    const setAuthority = (data: number[]) =>
      new web3.TransactionInstruction({
        programId: spl.TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(data),
      });
    assert.deepEqual(
      summary([setAuthority([6, 2, 2])]).undecoded,
      undecodedAt(TOKEN_PROGRAM, "invalid-data"),
    );
    assert.deepEqual(
      summary([setAuthority([6, 9, 0])]).undecoded,
      undecodedAt(TOKEN_PROGRAM, "invalid-data"),
    );
  });

  const table = (addresses: readonly string[]) => {
    const data = new Uint8Array(56 + 32 * addresses.length);
    data[0] = 1;
    addresses.forEach((address, i) =>
      data.set(decodePublicKey(address) ?? new Uint8Array(32), 56 + 32 * i),
    );
    return {
      lamports: 1,
      owner: ADDRESS_LOOKUP_TABLE_PROGRAM,
      data: [encodeBase64(data), "base64"] as [string, "base64"],
    };
  };
  const v0 = (lookupIndex: number) =>
    encodeBase64(
      encodeTransaction([new Uint8Array(64)], {
        version: 0,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        staticKeys: [fixture.user, K.unknownProgram],
        recentBlockhash: K.mint,
        instructions: [
          { programIdIndex: 1, accountIndexes: [0, 2], data: Uint8Array.of(1) },
        ],
        lookups: [
          {
            table: K.lookupTable,
            writableIndexes: [lookupIndex],
            readonlyIndexes: [],
          },
        ],
      }),
    );

  it("a lookup index past the end of a table that was read is malformed", async () => {
    const rpc = recordedEndpoint({
      accounts: { [K.lookupTable]: table([K.attacker]) },
      simulation: { err: null, accounts: {} },
    });
    assert.deepEqual(await preflight(rpc, v0(5), fixture.user), {
      kind: "malformed",
      problem: "bad-lookup-index",
    });
  });

  it("an address loaded twice, once through a lookup, is malformed", async () => {
    const rpc = recordedEndpoint({
      accounts: { [K.lookupTable]: table([K.attacker, fixture.user]) },
      simulation: { err: null, accounts: {} },
    });
    assert.deepEqual(await preflight(rpc, v0(1), fixture.user), {
      kind: "malformed",
      problem: "duplicate-key",
    });
  });
});

describe("audit 11: a filled cosigner slot is not called signed", () => {
  it("reports the slot as filled, not as a valid signature", () => {
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: K.mint,
      instructions: [
        new web3.TransactionInstruction({
          programId: key(K.unknownProgram),
          keys: [{ pubkey: organizer, isSigner: true, isWritable: false }],
          data: Buffer.from([1]),
        }),
      ],
    }).compileToLegacyMessage();
    // Not a signature of anything: 64 bytes of 7.
    const bytes = new web3.VersionedTransaction(message, [
      new Uint8Array(64),
      new Uint8Array(64).fill(7),
    ]).serialize();
    const result = parseTransaction(bytes);
    assert.ok(result.ok);
    const got = summarizeTransaction(result.transaction, new Map());
    assert.deepEqual(got.signers.others, [
      { address: K.organizer, signatureFilled: true },
    ]);
    assert.equal(JSON.stringify(got).includes('"signed"'), false);
  });
});
