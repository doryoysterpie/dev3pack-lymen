// E-06 done test against devnet: mint one pass, try to transfer it (must fail on chain), then
// burn it as permanent delegate (must succeed). It spends devnet SOL from the organizer key, so
// it runs by hand, not in CI:
//
//   npm run check:devnet -w @limen/api
//
// It reads SOLANA_RPC_URL and ORGANIZER_KEYPAIR_PATH from the root .env. HOLDER_ADDRESS, if set,
// is the wallet that receives the pass (for example the fake wallet's active account); it is
// then left holding the pass, and the transfer and burn steps use a throwaway holder instead.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getMetadataPointerState,
  getMint,
  getNonTransferable,
  getPermanentDelegate,
  getTokenMetadata,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";

import { devnetEndpoint } from "../devnet-endpoint.ts";
import { loadOrganizerKey } from "../organizer-key.ts";
import {
  devnetConnection,
  mintPass,
  passAccountLen,
  passTokenAccount,
  revokePass,
  PASS_NAME,
  PASS_SYMBOL,
} from "../pass-mint.ts";

const explorer = (kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

let connection: Connection;
let organizer: Keypair;

async function passState(mint: PublicKey, holder: PublicKey) {
  const info = await connection.getAccountInfo(mint, "confirmed");
  const m = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const account = await getAccount(
    connection,
    passTokenAccount(mint, holder),
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  return { info, m, amount: account.amount };
}

test("devnet: setup", async () => {
  // SOLANA_RPC_URL may name only the devnet endpoint; the check uses limen's one connection.
  devnetEndpoint(process.env.SOLANA_RPC_URL);
  connection = devnetConnection();
  organizer = Keypair.fromSecretKey(
    loadOrganizerKey(process.env.ORGANIZER_KEYPAIR_PATH).secretKeyBytes(),
  );
  const balance = await connection.getBalance(organizer.publicKey, "confirmed");
  console.log(
    `organizer ${organizer.publicKey.toBase58()} holds ${balance / LAMPORTS_PER_SOL} SOL`,
  );
  assert.ok(
    balance >= 0.05 * LAMPORTS_PER_SOL,
    "fund the organizer key with devnet SOL first",
  );
});

test("devnet: a minted pass has the owed extensions, metadata and a supply of one", async () => {
  const holder = Keypair.generate().publicKey;
  const details = {
    station: "st-front",
    session: "build-window",
    checkedInAt: Math.floor(Date.now() / 1000),
  };
  const { mint, signature } = await mintPass(organizer, holder, details);
  console.log(
    `mint ${explorer("address", mint.toBase58())}\n  tx ${explorer("tx", signature)}`,
  );
  const { info, m, amount } = await passState(mint, holder);

  assert.equal(info?.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(info?.data.length, passAccountLen(details));
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
  const metadata = await getTokenMetadata(
    connection,
    mint,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  assert.equal(metadata?.name, PASS_NAME);
  assert.equal(metadata?.symbol, PASS_SYMBOL);
  assert.deepEqual(metadata?.additionalMetadata, [
    ["station", "st-front"],
    ["session", "build-window"],
    [
      "checked_in_at",
      new Date(details.checkedInAt * 1000).toISOString().replace(".000Z", "Z"),
    ],
  ]);
  assert.equal(amount, 1n);
});

test("devnet done test: a transfer attempt fails on chain, and the delegate burn succeeds", async () => {
  const holder = Keypair.generate();
  const other = Keypair.generate().publicKey;
  const details = {
    station: "st-front",
    session: "build-window",
    checkedInAt: Math.floor(Date.now() / 1000),
  };
  const { mint } = await mintPass(organizer, holder.publicKey, details);

  // A destination account for the attempt, paid by the organizer.
  const otherAccount = passTokenAccount(mint, other);
  const setup = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      organizer.publicKey,
      otherAccount,
      other,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await connection
    .sendTransaction(setup, [organizer], { preflightCommitment: "confirmed" })
    .then((sig) => connection.confirmTransaction(sig, "confirmed"));

  // The holder signs a transfer of its one token. Preflight is skipped so the transaction lands
  // and fails on chain rather than in simulation.
  const transfer = new Transaction().add(
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
  transfer.feePayer = organizer.publicKey;
  const transferSig = await connection.sendTransaction(
    transfer,
    [organizer, holder],
    { skipPreflight: true },
  );
  await connection.confirmTransaction(transferSig, "confirmed");
  const landed = await connection.getTransaction(transferSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  console.log(`transfer attempt ${explorer("tx", transferSig)}`);
  console.log(`  err ${JSON.stringify(landed?.meta?.err)}`);
  console.log(
    `  logs ${JSON.stringify(landed?.meta?.logMessages?.filter((l) => /Program log/.test(l)))}`,
  );
  assert.notEqual(landed, null, "the failed transfer is recorded on chain");
  assert.deepEqual(landed?.meta?.err, {
    InstructionError: [0, { Custom: 37 }],
  });
  assert.ok(
    landed?.meta?.logMessages?.some((l) =>
      l.includes("Transfer is disabled for this mint"),
    ),
  );
  assert.equal(
    (await passState(mint, holder.publicKey)).amount,
    1n,
    "the holder still holds the pass",
  );

  const burnSig = await revokePass(organizer, mint, holder.publicKey);
  console.log(`delegate burn ${explorer("tx", burnSig)}`);
  const after = await passState(mint, holder.publicKey);
  assert.equal(after.amount, 0n);
  assert.equal(after.m.supply, 0n);
});

test(
  "devnet: a pass for HOLDER_ADDRESS, left in place for the wallet check",
  { skip: !process.env.HOLDER_ADDRESS },
  async () => {
    const holder = new PublicKey(process.env.HOLDER_ADDRESS ?? "");
    const details = {
      station: "st-front",
      session: "build-window",
      checkedInAt: Math.floor(Date.now() / 1000),
    };
    const { mint, tokenAccount, signature } = await mintPass(
      organizer,
      holder,
      details,
    );
    console.log(
      `pass for ${holder.toBase58()}\n  mint ${explorer("address", mint.toBase58())}\n  account ${tokenAccount.toBase58()}\n  tx ${explorer("tx", signature)}`,
    );
    assert.equal((await passState(mint, holder)).amount, 1n);
  },
);
