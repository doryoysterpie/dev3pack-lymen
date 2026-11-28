// Cross-checks the decoder against independent encoders: @solana/web3.js
// 1.99.0 and @solana/spl-token 0.4.15 build each transaction, and their own
// readers or the builders' inputs give the owed answer. Inputs come from a
// seeded generator, so a failure replays.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { asSigners } from "../test-support/build.ts";
import { messageAccounts } from "./accounts.ts";
import { decodeInstruction, type Decoded } from "./decode.ts";
import { parseTransaction } from "./wire.ts";

let seed = 0x9e3779b9;
function random(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}
const pick = (n: number) => Math.floor(random() * n);
const bytes = (n: number) => Uint8Array.from({ length: n }, () => pick(256));
const key = () => new web3.PublicKey(bytes(32));
const u64 = () =>
  [
    BigInt(0),
    BigInt(1),
    BigInt("18446744073709551615"),
    BigInt(pick(2 ** 31)) * BigInt(pick(2 ** 31)),
  ][pick(4)];

function serialize(message: web3.VersionedMessage): Uint8Array {
  const signatures = Array.from(
    { length: message.header.numRequiredSignatures },
    () => bytes(64),
  );
  return new web3.VersionedTransaction(message, signatures).serialize();
}

describe("cross-check: wire format and account order against web3.js", () => {
  it("matches web3.js on 200 random legacy and v0 transactions", () => {
    let withLookups = 0;
    for (let round = 0; round < 200; round += 1) {
      const payer = key();
      const signers = [payer, ...Array.from({ length: pick(3) }, key)];
      const pool = [...signers, ...Array.from({ length: 2 + pick(10) }, key)];
      const v0 = round % 2 === 1;
      const tables = v0
        ? Array.from(
            { length: pick(3) },
            () =>
              new web3.AddressLookupTableAccount({
                key: key(),
                state: {
                  deactivationSlot: BigInt("18446744073709551615"),
                  lastExtendedSlot: 0,
                  lastExtendedSlotStartIndex: 0,
                  addresses: Array.from({ length: 1 + pick(12) }, key),
                },
              }),
          )
        : [];
      const lookupPool = tables.flatMap((table) => table.state.addresses);
      const instructions = Array.from(
        { length: 1 + pick(5) },
        () =>
          new web3.TransactionInstruction({
            programId: key(),
            keys: Array.from({ length: pick(6) }, () => {
              const fromLookup = lookupPool.length > 0 && random() < 0.4;
              const pubkey = fromLookup
                ? lookupPool[pick(lookupPool.length)]
                : pool[pick(pool.length)];
              const isSigner =
                !fromLookup &&
                signers.some((s) => s.equals(pubkey)) &&
                random() < 0.7;
              return { pubkey, isSigner, isWritable: random() < 0.5 };
            }),
            data: Buffer.from(bytes(pick(200))),
          }),
      );
      const compiled = new web3.TransactionMessage({
        payerKey: payer,
        recentBlockhash: key().toBase58(),
        instructions,
      });
      const message = v0
        ? compiled.compileToV0Message(tables)
        : compiled.compileToLegacyMessage();
      const wire = serialize(message);
      const back = web3.VersionedTransaction.deserialize(wire);
      const result = parseTransaction(wire);
      assert.ok(result.ok, `round ${round}: ${JSON.stringify(result)}`);
      const parsed = result.transaction;
      const m = back.message;
      if (m.addressTableLookups.length > 0) withLookups += 1;

      assert.equal(parsed.message.version, m.version);
      assert.deepEqual(parsed.message.header, m.header);
      assert.deepEqual(
        parsed.message.staticKeys,
        m.staticAccountKeys.map((k) => k.toBase58()),
      );
      assert.equal(parsed.message.recentBlockhash, m.recentBlockhash);
      assert.deepEqual(
        parsed.message.instructions.map((ix) => [
          ix.programIdIndex,
          ix.accountIndexes,
          Array.from(ix.data),
        ]),
        m.compiledInstructions.map((ix) => [
          ix.programIdIndex,
          Array.from(ix.accountKeyIndexes),
          Array.from(ix.data),
        ]),
      );
      assert.deepEqual(
        parsed.message.lookups.map((l) => [
          l.table,
          l.writableIndexes,
          l.readonlyIndexes,
        ]),
        m.addressTableLookups.map((l) => [
          l.accountKey.toBase58(),
          Array.from(l.writableIndexes),
          Array.from(l.readonlyIndexes),
        ]),
      );
      assert.deepEqual(
        Array.from(parsed.messageBytes),
        Array.from(m.serialize()),
      );

      const tableMap = new Map(
        tables.map((t) => [
          t.key.toBase58(),
          t.state.addresses.map((a) => a.toBase58()),
        ]),
      );
      const keys = m
        .getAccountKeys({ addressLookupTableAccounts: tables })
        .keySegments()
        .flat();
      assert.deepEqual(
        messageAccounts(parsed.message, tableMap).map((a) => [
          a.address,
          a.signer,
          a.writable,
        ]),
        keys.map((k, i) => [
          k.toBase58(),
          m.isAccountSigner(i),
          m.isAccountWritable(i),
        ]),
      );
    }
    assert.ok(
      withLookups > 20,
      `only ${withLookups} rounds used lookup tables`,
    );
  });
});

function decodeOne(
  instruction: web3.TransactionInstruction,
  payer: web3.PublicKey,
): Decoded {
  const message = new web3.TransactionMessage({
    payerKey: payer,
    recentBlockhash: key().toBase58(),
    instructions: [instruction],
  }).compileToLegacyMessage();
  const result = parseTransaction(serialize(message));
  assert.ok(result.ok);
  const accounts = messageAccounts(result.transaction.message, new Map());
  return decodeInstruction(
    result.transaction.message.instructions[0],
    accounts,
  );
}

const addressOf = (account: { address: string | null } | null) =>
  account === null ? null : account.address;

describe("cross-check: instruction decoder against spl-token and web3.js builders", () => {
  it("decodes what the builders built, for both token programs and multisig owners", () => {
    const typeNames = [
      "MintTokens",
      "FreezeAccount",
      "AccountOwner",
      "CloseAccount",
      "TransferFeeConfig",
      "WithheldWithdraw",
      "CloseMint",
      "InterestRate",
      "PermanentDelegate",
      "ConfidentialTransferMint",
      "TransferHookProgramId",
      "ConfidentialTransferFeeConfig",
      "MetadataPointer",
      "GroupPointer",
      "GroupMemberPointer",
      "ScaledUiAmount",
      "Pause",
    ];
    for (let round = 0; round < 60; round += 1) {
      for (const [name, programId] of [
        ["token", spl.TOKEN_PROGRAM_ID],
        ["token-2022", spl.TOKEN_2022_PROGRAM_ID],
      ] as const) {
        const payer = key();
        const [source, destination, owner, mint, delegate, next] = [
          key(),
          key(),
          key(),
          key(),
          key(),
          key(),
        ];
        const multisig = random() < 0.3 ? [key(), key()] : [];
        const authority = multisig.length > 0 ? key() : owner;
        const authorizers = [authority, ...multisig].map((k) => k.toBase58());
        const amount = u64();
        const decimals = pick(12);

        let d = decodeOne(
          spl.createTransferInstruction(
            source,
            destination,
            authority,
            amount,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        if (name === "token-2022") {
          // Not decoded on Token-2022 (decode.ts, TOKEN_2022_NOT_DECODED).
          assert.deepEqual(d, {
            kind: "undecoded",
            programId: spl.TOKEN_2022_PROGRAM_ID.toBase58(),
            reason: "instruction-not-decoded",
          });
        } else {
          assert.ok(d.kind === "token-transfer");
          assert.deepEqual(
            [
              d.program,
              addressOf(d.source),
              addressOf(d.destination),
              d.mint,
              d.authorizers.map(addressOf),
              d.amount,
              d.decimals,
            ],
            [
              name,
              source.toBase58(),
              destination.toBase58(),
              null,
              authorizers,
              amount.toString(),
              null,
            ],
          );
        }

        d = decodeOne(
          spl.createTransferCheckedInstruction(
            source,
            mint,
            destination,
            authority,
            amount,
            decimals,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        if (name === "token-2022") {
          // Not decoded on Token-2022 (decode.ts, TOKEN_2022_NOT_DECODED).
          assert.deepEqual(d, {
            kind: "undecoded",
            programId: spl.TOKEN_2022_PROGRAM_ID.toBase58(),
            reason: "instruction-not-decoded",
          });
        } else {
          assert.ok(d.kind === "token-transfer");
          assert.deepEqual(
            [
              addressOf(d.source),
              addressOf(d.destination),
              addressOf(d.mint),
              d.authorizers.map(addressOf),
              d.amount,
              d.decimals,
            ],
            [
              source.toBase58(),
              destination.toBase58(),
              mint.toBase58(),
              authorizers,
              amount.toString(),
              decimals,
            ],
          );
        }

        d = decodeOne(
          spl.createApproveInstruction(
            source,
            delegate,
            authority,
            amount,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        assert.ok(d.kind === "token-approve");
        assert.deepEqual(
          [
            addressOf(d.source),
            addressOf(d.delegate),
            d.mint,
            d.authorizers.map(addressOf),
            d.amount,
          ],
          [
            source.toBase58(),
            delegate.toBase58(),
            null,
            authorizers,
            amount.toString(),
          ],
        );

        d = decodeOne(
          spl.createApproveCheckedInstruction(
            source,
            mint,
            delegate,
            authority,
            amount,
            decimals,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        assert.ok(d.kind === "token-approve");
        assert.deepEqual(
          [addressOf(d.delegate), addressOf(d.mint), d.amount, d.decimals],
          [delegate.toBase58(), mint.toBase58(), amount.toString(), decimals],
        );

        d = decodeOne(
          spl.createRevokeInstruction(
            source,
            authority,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        assert.ok(d.kind === "token-revoke");
        assert.deepEqual(
          [addressOf(d.source), d.authorizers.map(addressOf)],
          [source.toBase58(), authorizers],
        );

        const types =
          name === "token" ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 8, 12, 16];
        const type = types[pick(types.length)];
        const newAuthority = random() < 0.5 ? next : null;
        d = decodeOne(
          spl.createSetAuthorityInstruction(
            source,
            authority,
            type,
            newAuthority,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        assert.ok(d.kind === "token-set-authority");
        assert.deepEqual(
          [
            addressOf(d.target),
            d.authorizers.map(addressOf),
            d.authorityType,
            d.newAuthority,
          ],
          [
            source.toBase58(),
            authorizers,
            typeNames[type],
            newAuthority?.toBase58() ?? null,
          ],
        );

        d = decodeOne(
          spl.createCloseAccountInstruction(
            source,
            destination,
            authority,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        if (name === "token-2022") {
          // Not decoded on Token-2022 (decode.ts, TOKEN_2022_NOT_DECODED).
          assert.deepEqual(d, {
            kind: "undecoded",
            programId: spl.TOKEN_2022_PROGRAM_ID.toBase58(),
            reason: "instruction-not-decoded",
          });
        } else {
          assert.ok(d.kind === "token-close-account");
          assert.deepEqual(
            [
              addressOf(d.account),
              addressOf(d.destination),
              d.authorizers.map(addressOf),
            ],
            [source.toBase58(), destination.toBase58(), authorizers],
          );
        }

        d = decodeOne(
          spl.createBurnCheckedInstruction(
            source,
            mint,
            authority,
            amount,
            decimals,
            asSigners(multisig),
            programId,
          ),
          payer,
        );
        assert.ok(d.kind === "token-burn");
        assert.deepEqual(
          [addressOf(d.account), addressOf(d.mint), d.amount, d.decimals],
          [source.toBase58(), mint.toBase58(), amount.toString(), decimals],
        );

        d = decodeOne(
          spl.createAssociatedTokenAccountIdempotentInstruction(
            payer,
            destination,
            owner,
            mint,
            programId,
          ),
          payer,
        );
        assert.ok(d.kind === "create-token-account");
        assert.deepEqual(
          [
            d.idempotent,
            addressOf(d.funder),
            addressOf(d.account),
            addressOf(d.wallet),
            addressOf(d.mint),
          ],
          [
            true,
            payer.toBase58(),
            destination.toBase58(),
            owner.toBase58(),
            mint.toBase58(),
          ],
        );
      }

      const payer = key();
      const [to, program, created, nonce, derived] = [
        key(),
        key(),
        key(),
        key(),
        key(),
      ];
      const lamports = pick(2 ** 31) * 1000;
      let d = decodeOne(
        web3.SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: to,
          lamports,
        }),
        payer,
      );
      assert.ok(d.kind === "sol-transfer");
      assert.deepEqual(
        [addressOf(d.from), addressOf(d.to), d.lamports],
        [payer.toBase58(), to.toBase58(), String(lamports)],
      );

      d = decodeOne(
        web3.SystemProgram.assign({ accountPubkey: payer, programId: program }),
        payer,
      );
      assert.ok(d.kind === "assign");
      assert.deepEqual(
        [addressOf(d.account), d.owner],
        [payer.toBase58(), program.toBase58()],
      );

      d = decodeOne(
        web3.SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: created,
          lamports,
          space: 165,
          programId: program,
        }),
        payer,
      );
      assert.ok(d.kind === "create-account");
      assert.deepEqual(
        [addressOf(d.funder), addressOf(d.account), d.lamports, d.owner],
        [
          payer.toBase58(),
          created.toBase58(),
          String(lamports),
          program.toBase58(),
        ],
      );

      const seedText = "s".repeat(1 + pick(30));
      d = decodeOne(
        web3.SystemProgram.transfer({
          fromPubkey: derived,
          basePubkey: payer,
          toPubkey: to,
          lamports,
          seed: seedText,
          programId: program,
        }),
        payer,
      );
      assert.ok(d.kind === "sol-transfer-with-seed");
      assert.deepEqual(
        [addressOf(d.from), addressOf(d.base), addressOf(d.to), d.lamports],
        [derived.toBase58(), payer.toBase58(), to.toBase58(), String(lamports)],
      );

      d = decodeOne(
        web3.SystemProgram.nonceAdvance({
          noncePubkey: nonce,
          authorizedPubkey: payer,
        }),
        payer,
      );
      assert.ok(d.kind === "advance-nonce");
      assert.deepEqual(
        [addressOf(d.nonce), addressOf(d.authority)],
        [nonce.toBase58(), payer.toBase58()],
      );

      const units = pick(1400000);
      d = decodeOne(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units }),
        payer,
      );
      assert.deepEqual(d, {
        kind: "compute-budget",
        name: "SetComputeUnitLimit",
        value: String(units),
      });
      const price = pick(2 ** 31) * 7;
      d = decodeOne(
        web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
        payer,
      );
      assert.deepEqual(d, {
        kind: "compute-budget",
        name: "SetComputeUnitPrice",
        value: String(price),
      });
    }
  });
});
