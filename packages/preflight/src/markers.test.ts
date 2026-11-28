// The owner's audit of E-09 at 77f925f, item 4: every account named in an
// instruction the wallet signs gets a marker in the report, whatever the
// instruction. Generated for every instruction kind the decoder decodes,
// with the wallet as signer, offline and with a run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { endpointFor, recordedEndpoint } from "../test-support/recorded.ts";
import { decodeInstruction } from "./decode.ts";
import { messageAccounts } from "./accounts.ts";
import { preflightTransaction } from "./preflight.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import { parseTransaction } from "./wire.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as { readonly user: string; readonly keys: Readonly<Record<string, string>> };
const USER = fixture.user;
const user = new web3.PublicKey(USER);
const fresh = () => web3.PublicKey.unique();
const RENT = new web3.PublicKey("SysvarRent111111111111111111111111111111111");
const PROGRAMS = new Set([
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  RENT.toBase58(),
  "SysvarRecentB1ockHashes11111111111111111111",
]);

/** The wallet as one more signer, for instructions that take no signer. */
const withWallet = (ix: web3.TransactionInstruction) =>
  new web3.TransactionInstruction({
    programId: ix.programId,
    data: ix.data,
    keys: [...ix.keys, { pubkey: user, isSigner: true, isWritable: false }],
  });

function kinds(): ReadonlyArray<
  readonly [string, web3.TransactionInstruction]
> {
  const out: [string, web3.TransactionInstruction][] = [
    [
      "System Transfer",
      web3.SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: fresh(),
        lamports: 5,
      }),
    ],
    [
      "System TransferWithSeed",
      web3.SystemProgram.transfer({
        fromPubkey: fresh(),
        basePubkey: user,
        toPubkey: fresh(),
        lamports: 5,
        seed: "s",
        programId: fresh(),
      }),
    ],
    [
      "System CreateAccount",
      withWallet(
        web3.SystemProgram.createAccount({
          fromPubkey: user,
          newAccountPubkey: fresh(),
          lamports: 5,
          space: 0,
          programId: fresh(),
        }),
      ),
    ],
    [
      "System Assign",
      web3.SystemProgram.assign({ accountPubkey: user, programId: fresh() }),
    ],
    [
      "System AdvanceNonceAccount",
      web3.SystemProgram.nonceAdvance({
        noncePubkey: fresh(),
        authorizedPubkey: user,
      }),
    ],
    [
      "ATA Create",
      spl.createAssociatedTokenAccountInstruction(
        user,
        fresh(),
        fresh(),
        fresh(),
      ),
    ],
    [
      "ATA CreateIdempotent",
      spl.createAssociatedTokenAccountIdempotentInstruction(
        user,
        fresh(),
        fresh(),
        fresh(),
      ),
    ],
    [
      "Compute budget",
      withWallet(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
      ),
    ],
    [
      "Memo",
      new web3.TransactionInstruction({
        programId: new web3.PublicKey(MEMO_PROGRAM),
        keys: [
          { pubkey: user, isSigner: true, isWritable: false },
          { pubkey: fresh(), isSigner: true, isWritable: false },
        ],
        data: Buffer.from("hi"),
      }),
    ],
  ];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const id = new web3.PublicKey(program);
    const name = program === TOKEN_PROGRAM ? "Token" : "Token-2022";
    out.push(
      [
        `${name} Approve`,
        spl.createApproveInstruction(fresh(), fresh(), user, 5, [], id),
      ],
      [
        `${name} ApproveChecked`,
        spl.createApproveCheckedInstruction(
          fresh(),
          fresh(),
          fresh(),
          user,
          5,
          0,
          [],
          id,
        ),
      ],
      [`${name} Revoke`, spl.createRevokeInstruction(fresh(), user, [], id)],
      [
        `${name} SetAuthority`,
        spl.createSetAuthorityInstruction(
          fresh(),
          user,
          spl.AuthorityType.AccountOwner,
          fresh(),
          [],
          id,
        ),
      ],
      [
        `${name} Burn`,
        spl.createBurnInstruction(fresh(), fresh(), user, 5, [], id),
      ],
      [
        `${name} BurnChecked`,
        spl.createBurnCheckedInstruction(fresh(), fresh(), user, 5, 0, [], id),
      ],
      [
        `${name} MintTo`,
        spl.createMintToInstruction(fresh(), fresh(), user, 5, [], id),
      ],
      [
        `${name} MintToChecked`,
        spl.createMintToCheckedInstruction(
          fresh(),
          fresh(),
          user,
          5,
          0,
          [],
          id,
        ),
      ],
      [
        `${name} InitializeAccount`,
        withWallet(
          spl.createInitializeAccountInstruction(fresh(), fresh(), fresh(), id),
        ),
      ],
      [
        `${name} SyncNative`,
        withWallet(spl.createSyncNativeInstruction(fresh(), id)),
      ],
      [
        `${name} InitializeAccount3`,
        withWallet(
          spl.createInitializeAccount3Instruction(
            fresh(),
            fresh(),
            fresh(),
            id,
          ),
        ),
      ],
      [
        `${name} InitializeImmutableOwner`,
        withWallet(spl.createInitializeImmutableOwnerInstruction(fresh(), id)),
      ],
    );
    if (program === TOKEN_PROGRAM) {
      out.push(
        [
          `${name} Transfer`,
          spl.createTransferInstruction(fresh(), fresh(), user, 5, [], id),
        ],
        [
          `${name} TransferChecked`,
          spl.createTransferCheckedInstruction(
            fresh(),
            fresh(),
            fresh(),
            user,
            5,
            0,
            [],
            id,
          ),
        ],
        [
          `${name} CloseAccount`,
          spl.createCloseAccountInstruction(fresh(), fresh(), user, [], id),
        ],
      );
    }
  }
  return out;
}

function build(instruction: web3.TransactionInstruction): Uint8Array {
  const message = new web3.TransactionMessage({
    payerKey: user,
    recentBlockhash: fixture.keys.mint,
    instructions: [instruction],
  }).compileToLegacyMessage();
  const signatures = Array.from(
    { length: message.header.numRequiredSignatures },
    () => new Uint8Array(64),
  );
  return new web3.VersionedTransaction(message, signatures).serialize();
}

const offline = () =>
  endpointFor(async () => {
    throw new Error("offline");
  }, "x");
const withRun = () =>
  recordedEndpoint({
    accounts: {
      [USER]: {
        lamports: 5_000_000_000,
        owner: SYSTEM_PROGRAM,
        data: ["", "base64"],
      },
    },
    simulation: { err: null, accounts: {} },
  });

describe("re-audit 2, item 4: every account an instruction the wallet signs names is marked", () => {
  for (const [name, instruction] of kinds()) {
    it(`${name}: no named account's address is in the report`, async () => {
      const bytes = build(instruction);
      // The kind is one the decoder decodes, with the wallet as a signer.
      const parsed = parseTransaction(bytes);
      assert.ok(parsed.ok);
      const accounts = messageAccounts(parsed.transaction.message, new Map());
      const decoded = decodeInstruction(
        parsed.transaction.message.instructions[0],
        accounts,
      );
      assert.notEqual(decoded.kind, "undecoded", name);
      const named = instruction.keys
        .map((meta) => meta.pubkey.toBase58())
        .filter((address) => address !== USER && !PROGRAMS.has(address));
      // Assign and a compute budget instruction name no account but the
      // wallet; every other kind names at least one.
      if (!name.startsWith("System Assign") && name !== "Compute budget") {
        assert.ok(named.length > 0, name);
      }
      for (const endpoint of [offline(), withRun()]) {
        const result = await preflightTransaction(bytes, {
          endpoint,
          user: USER,
        });
        assert.equal(result.summary.kind, "ready", name);
        const json = JSON.stringify(result);
        for (const address of named) {
          assert.equal(json.includes(address), false, `${name}: ${address}`);
        }
      }
    });
  }
});
