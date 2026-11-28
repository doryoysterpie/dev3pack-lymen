// E-06 done test in an in-process SVM (litesvm 0.8.0). These tests show what the real
// Token-2022 program does when it runs inside litesvm's in-process SVM, using the Token-2022 and
// associated token programs that ship inside the litesvm package. They do not show devnet
// behaviour; src/devnet/pass-mint.check.ts runs the same steps against devnet.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  ExtensionType,
  getExtensionData,
  getMetadataPointerState,
  getNonTransferable,
  getPermanentDelegate,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Keypair,
  Transaction,
  type Connection,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";

import {
  buildPassMintTransaction,
  buildRevokeTransaction,
  DEVNET_GENESIS_HASH,
  passAccountLen,
  passMintState,
  passTokenAccount,
} from "./pass-mint.ts";

const DETAILS = {
  station: "st-front",
  session: "build-window",
  checkedInAt: 1_795_811_665,
};

function setup() {
  const svm = new LiteSVM();
  const organizer = Keypair.generate();
  const mint = Keypair.generate();
  const holder = Keypair.generate();
  svm.airdrop(organizer.publicKey, 10_000_000_000n);
  const lamports = Number(
    svm.minimumBalanceForRentExemption(BigInt(passAccountLen(DETAILS))),
  );
  const tx = buildPassMintTransaction({
    organizer: organizer.publicKey,
    mint: mint.publicKey,
    holder: holder.publicKey,
    details: DETAILS,
    lamports,
  });
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(organizer, mint);
  const result = svm.sendTransaction(tx);
  assert.ok(
    !(result instanceof FailedTransactionMetadata),
    `pass mint failed: ${String(result)}`,
  );
  return { svm, organizer, mint: mint.publicKey, holder };
}

function send(
  svm: LiteSVM,
  payer: Keypair,
  signers: Keypair[],
  ...ix: TransactionInstruction[]
) {
  const tx = new Transaction().add(...ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer, ...signers);
  return svm.sendTransaction(tx);
}

function mintState(svm: LiteSVM, mint: PublicKey) {
  const info = svm.getAccount(mint);
  assert.ok(info !== null);
  return {
    dataLength: info.data.length,
    mint: unpackMint(
      mint,
      { ...info, data: Buffer.from(info.data) },
      TOKEN_2022_PROGRAM_ID,
    ),
  };
}

function balance(svm: LiteSVM, mint: PublicKey, holder: PublicKey): bigint {
  const address = passTokenAccount(mint, holder);
  const info = svm.getAccount(address);
  assert.ok(info !== null);
  return unpackAccount(
    address,
    { ...info, data: Buffer.from(info.data) },
    TOKEN_2022_PROGRAM_ID,
  ).amount;
}

/** Reads a TokenMetadata value by its Borsh layout, independently of the code that sized it. */
function readMetadata(data: Buffer) {
  let at = 0;
  const key = () => {
    const k = data.subarray(at, at + 32);
    at += 32;
    return k;
  };
  const str = () => {
    const n = data.readUInt32LE(at);
    const s = data.subarray(at + 4, at + 4 + n).toString("utf8");
    at += 4 + n;
    return s;
  };
  const updateAuthority = key();
  const mint = key();
  const name = str();
  const symbol = str();
  const uri = str();
  const count = data.readUInt32LE(at);
  at += 4;
  const fields: [string, string][] = [];
  for (let i = 0; i < count; i++) fields.push([str(), str()]);
  assert.equal(at, data.length, "the metadata has no bytes beyond its fields");
  return { updateAuthority, mint, name, symbol, uri, fields };
}

test("in-process SVM: a minted pass has the owed extensions, metadata and a supply of one", () => {
  const { svm, organizer, mint, holder } = setup();
  const { dataLength, mint: m } = mintState(svm, mint);
  assert.equal(
    svm.getAccount(mint)?.owner.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
  );
  assert.equal(dataLength, passAccountLen(DETAILS));
  assert.equal(dataLength, 473);
  assert.equal(m.decimals, 0);
  assert.equal(m.supply, 1n);
  assert.equal(m.mintAuthority?.toBase58(), organizer.publicKey.toBase58());
  assert.equal(m.freezeAuthority, null);
  assert.notEqual(getNonTransferable(m), null);
  assert.equal(
    getPermanentDelegate(m)?.delegate.toBase58(),
    organizer.publicKey.toBase58(),
  );
  const pointer = getMetadataPointerState(m);
  assert.equal(pointer?.authority?.toBase58(), organizer.publicKey.toBase58());
  assert.equal(pointer?.metadataAddress?.toBase58(), mint.toBase58());

  const raw = getExtensionData(ExtensionType.TokenMetadata, m.tlvData);
  assert.ok(raw !== null);
  const metadata = readMetadata(Buffer.from(raw));
  assert.deepEqual(metadata.updateAuthority, organizer.publicKey.toBuffer());
  assert.deepEqual(metadata.mint, mint.toBuffer());
  assert.equal(metadata.name, "limen check-in pass");
  assert.equal(metadata.symbol, "LIMEN");
  assert.equal(metadata.uri, "");
  assert.deepEqual(metadata.fields, [
    ["station", "st-front"],
    ["session", "build-window"],
    ["checked_in_at", "2026-11-27T20:34:25Z"],
  ]);
  assert.equal(balance(svm, mint, holder.publicKey), 1n);
});

test("done test, in-process SVM: a transfer attempt fails with Token-2022 error 37 and the holder keeps the pass", () => {
  const { svm, organizer, mint, holder } = setup();
  const other = Keypair.generate().publicKey;
  const otherAccount = passTokenAccount(mint, other);
  const opened = send(
    svm,
    organizer,
    [],
    createAssociatedTokenAccountIdempotentInstruction(
      organizer.publicKey,
      otherAccount,
      other,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  assert.ok(!(opened instanceof FailedTransactionMetadata));

  const result = send(
    svm,
    organizer,
    [holder],
    createTransferCheckedInstruction(
      passTokenAccount(mint, holder.publicKey),
      mint,
      otherAccount,
      holder.publicKey,
      1,
      0,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  assert.ok(
    result instanceof FailedTransactionMetadata,
    "the transfer must fail",
  );
  assert.equal(
    result.err().toString(),
    "TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: 37 } }",
  );
  assert.ok(
    result
      .meta()
      .logs()
      .includes("Program log: Transfer is disabled for this mint"),
  );
  assert.equal(balance(svm, mint, holder.publicKey), 1n);
  assert.equal(balance(svm, mint, other), 0n);
});

test("done test, in-process SVM: the organizer burns the pass as permanent delegate", () => {
  const { svm, organizer, mint, holder } = setup();
  const tx = buildRevokeTransaction({
    organizer: organizer.publicKey,
    mint,
    holder: holder.publicKey,
  });
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(organizer);
  const result = svm.sendTransaction(tx);
  assert.ok(
    !(result instanceof FailedTransactionMetadata),
    `delegate burn failed: ${String(result)}`,
  );
  assert.equal(balance(svm, mint, holder.publicKey), 0n);
  assert.equal(mintState(svm, mint).mint.supply, 0n);
});

test("in-process SVM: a key that is not the permanent delegate cannot burn the pass", () => {
  const { svm, organizer, mint, holder } = setup();
  const stranger = Keypair.generate();
  const result = send(
    svm,
    organizer,
    [stranger],
    createBurnCheckedInstruction(
      passTokenAccount(mint, holder.publicKey),
      mint,
      stranger.publicKey,
      1,
      0,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  assert.ok(
    result instanceof FailedTransactionMetadata,
    "a stranger's burn must fail",
  );
  assert.equal(balance(svm, mint, holder.publicKey), 1n);
});

/** A Connection stand-in that answers devnet's genesis hash and reads accounts from litesvm. */
function svmConnection(svm: LiteSVM): Connection {
  return {
    getGenesisHash: async () => DEVNET_GENESIS_HASH,
    getAccountInfo: async (address: PublicKey) => {
      const info = svm.getAccount(address);
      return info === null ? null : { ...info, data: Buffer.from(info.data) };
    },
  } as unknown as Connection;
}

test("in-process SVM: passMintState reads a pass as absent, minted to its holder, or other", async () => {
  const { svm, organizer, mint, holder } = setup();
  const connection = svmConnection(svm);
  assert.equal(
    await passMintState(
      connection,
      Keypair.generate().publicKey,
      holder.publicKey,
    ),
    "absent",
  );
  assert.equal(
    await passMintState(connection, mint, holder.publicKey),
    "minted",
  );
  assert.equal(
    await passMintState(connection, mint, Keypair.generate().publicKey),
    "other",
  );
  // Burned by the organizer as permanent delegate, its supply is 0.
  const burned = send(
    svm,
    organizer,
    [],
    ...buildRevokeTransaction({
      organizer: organizer.publicKey,
      mint,
      holder: holder.publicKey,
    }).instructions,
  );
  assert.ok(!(burned instanceof FailedTransactionMetadata));
  assert.equal(
    await passMintState(connection, mint, holder.publicKey),
    "other",
  );
});
