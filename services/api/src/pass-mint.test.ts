// E-06, offline part: the pass mint and revoke transactions carry the owed instructions and
// parameters. The on-chain results (transfer fails, delegate burn succeeds) are checked against
// devnet by src/devnet/pass-mint.check.ts, which needs a funded key and does not run in CI.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeBurnCheckedInstruction,
  decodeInitializeMintInstruction,
  decodeMintToInstruction,
  TOKEN_2022_PROGRAM_ID,
  TokenInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  SystemInstruction,
  SystemProgram,
  type Connection,
  type Transaction,
} from "@solana/web3.js";

import {
  buildPassMintTransaction,
  buildRevokeTransaction,
  connectDevnet,
  DEVNET_GENESIS_HASH,
  mintPass,
  passAccountLen,
  passFields,
  passTokenAccount,
  revokePass,
  tokenMetadataLen,
} from "./pass-mint.ts";

const organizer = Keypair.generate();
const mint = Keypair.generate();
const holder = Keypair.generate().publicKey;
const DETAILS = {
  station: "st-front",
  session: "build-window",
  checkedInAt: 1_795_811_665,
};

function build(details = DETAILS) {
  return buildPassMintTransaction({
    organizer: organizer.publicKey,
    mint: mint.publicKey,
    holder,
    details,
    lamports: 4_181_760,
  });
}

test("the pass carries station, session and the check-in time in UTC as metadata fields", () => {
  assert.deepEqual(passFields(DETAILS), [
    ["station", "st-front"],
    ["session", "build-window"],
    ["checked_in_at", "2026-11-27T20:34:25Z"],
  ]);
});

test("the mint account size is the owed 274-byte mint plus a 4-byte TLV header plus its metadata", () => {
  // Base mint 82 bytes, padded to 165, plus 1 account-type byte: 166. Then TLV entries of
  // 4-byte header plus value: NonTransferable 0, PermanentDelegate 32, MetadataPointer 64.
  const mintLen = 166 + (4 + 0) + (4 + 32) + (4 + 64);
  assert.equal(mintLen, 274);
  // Metadata: authority 32 + mint 32 + "limen check-in pass" (4+19) + "LIMEN" (4+5) + "" (4+0)
  // + pair count 4 + station (4+7, 4+8) + session (4+7, 4+12) + checked_in_at (4+13, 4+20).
  const metadataLen = 64 + 23 + 9 + 4 + 4 + (11 + 12) + (11 + 16) + (17 + 24);
  assert.equal(
    tokenMetadataLen("limen check-in pass", "LIMEN", "", passFields(DETAILS)),
    metadataLen,
  );
  assert.equal(passAccountLen(DETAILS), mintLen + 4 + metadataLen);
  assert.equal(passAccountLen(DETAILS), 473);
});

test("the mint transaction creates a non-transferable mint with the organizer as permanent delegate", () => {
  const ix = build().instructions;
  assert.deepEqual(
    ix.map((i) => i.programId.toBase58()),
    [
      SystemProgram.programId,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    ].map((p) => p.toBase58()),
  );

  const create = SystemInstruction.decodeCreateAccount(ix[0]!);
  assert.equal(create.fromPubkey.toBase58(), organizer.publicKey.toBase58());
  assert.equal(create.newAccountPubkey.toBase58(), mint.publicKey.toBase58());
  assert.equal(create.space, 274);
  assert.equal(create.lamports, 4_181_760);
  assert.equal(create.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());

  // NonTransferable on the mint.
  assert.deepEqual(
    [...ix[1]!.data],
    [TokenInstruction.InitializeNonTransferableMint],
  );
  assert.equal(ix[1]!.keys[0]!.pubkey.toBase58(), mint.publicKey.toBase58());

  // PermanentDelegate = organizer.
  assert.equal(ix[2]!.data[0], TokenInstruction.InitializePermanentDelegate);
  assert.deepEqual(ix[2]!.data.subarray(1), organizer.publicKey.toBuffer());

  // MetadataPointer: authority organizer, metadata address the mint itself.
  assert.equal(ix[3]!.data[0], TokenInstruction.MetadataPointerExtension);
  assert.deepEqual(ix[3]!.data.subarray(2, 34), organizer.publicKey.toBuffer());
  assert.deepEqual(ix[3]!.data.subarray(34, 66), mint.publicKey.toBuffer());

  const init = decodeInitializeMintInstruction(
    ix[4]!,
    TOKEN_2022_PROGRAM_ID,
  ).data;
  assert.equal(init.decimals, 0);
  assert.equal(init.mintAuthority.toBase58(), organizer.publicKey.toBase58());
  assert.equal(init.freezeAuthority, null);
});

test("the metadata is written on the mint with the pass name, symbol and fields", () => {
  const ix = build().instructions;
  const text = (i: number) => ix[i]!.data.toString("latin1");
  assert.deepEqual(
    ix[5]!.keys.map((k) => k.pubkey.toBase58()),
    [
      mint.publicKey,
      organizer.publicKey,
      mint.publicKey,
      organizer.publicKey,
    ].map((k) => k.toBase58()),
  );
  assert.ok(
    text(5).includes("limen check-in pass") && text(5).includes("LIMEN"),
  );
  assert.ok(text(6).includes("station") && text(6).includes("st-front"));
  assert.ok(text(7).includes("session") && text(7).includes("build-window"));
  assert.ok(
    text(8).includes("checked_in_at") &&
      text(8).includes("2026-11-27T20:34:25Z"),
  );
  for (const i of [6, 7, 8]) {
    assert.equal(ix[i]!.keys[0]!.pubkey.toBase58(), mint.publicKey.toBase58());
    assert.equal(
      ix[i]!.keys[1]!.pubkey.toBase58(),
      organizer.publicKey.toBase58(),
    );
  }
});

test("exactly one token is minted to the holder's Token-2022 associated account", () => {
  const ix = build().instructions;
  const tokenAccount = passTokenAccount(mint.publicKey, holder);
  assert.deepEqual(
    ix[9]!.keys.slice(0, 4).map((k) => k.pubkey.toBase58()),
    [organizer.publicKey, tokenAccount, holder, mint.publicKey].map((k) =>
      k.toBase58(),
    ),
  );
  const mintTo = decodeMintToInstruction(ix[10]!, TOKEN_2022_PROGRAM_ID);
  assert.equal(mintTo.data.amount, 1n);
  assert.equal(
    mintTo.keys.destination.pubkey.toBase58(),
    tokenAccount.toBase58(),
  );
  assert.equal(
    mintTo.keys.authority.pubkey.toBase58(),
    organizer.publicKey.toBase58(),
  );
});

test("a pass with 64-character station and session IDs still fits in one transaction", () => {
  const tx = build({
    station: "s".repeat(64),
    session: "t".repeat(64),
    checkedInAt: 1_795_811_665,
  });
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.sign(organizer, mint);
  const size = tx.serialize().length;
  assert.ok(
    size <= 1232,
    `serialized size ${size} is over the 1232-byte limit`,
  );
});

test("station and session IDs over 64 bytes of UTF-8 are refused, before anything is sent", async () => {
  // At the limit, in ASCII and in two-byte characters, the pass builds and fits.
  for (const id of ["s".repeat(64), "é".repeat(32)]) {
    const tx = build({ station: id, session: id, checkedInAt: 1_795_811_665 });
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.sign(organizer, mint);
    assert.ok(tx.serialize().length <= 1232);
  }
  // One byte over, in either field, is refused with the field named.
  assert.throws(() => passFields({ ...DETAILS, station: "s".repeat(65) }), {
    message: "station is 65 bytes of UTF-8; a pass allows at most 64",
  });
  assert.throws(() => build({ ...DETAILS, session: "é".repeat(32) + "t" }), {
    message: "session is 65 bytes of UTF-8; a pass allows at most 64",
  });
  // mintPass refuses before it asks the cluster anything.
  const devnet = recordingConnection(DEVNET_GENESIS_HASH);
  await assert.rejects(
    mintPass(devnet.connection, organizer, holder, {
      ...DETAILS,
      session: "t".repeat(65),
    }),
    { message: "session is 65 bytes of UTF-8; a pass allows at most 64" },
  );
  assert.deepEqual(devnet.calls, []);
});

test("the revoke transaction burns the holder's one token with the organizer as signer", () => {
  const tx = buildRevokeTransaction({
    organizer: organizer.publicKey,
    mint: mint.publicKey,
    holder,
  });
  assert.equal(tx.instructions.length, 1);
  const burn = decodeBurnCheckedInstruction(
    tx.instructions[0]!,
    TOKEN_2022_PROGRAM_ID,
  );
  assert.equal(
    burn.keys.account.pubkey.toBase58(),
    passTokenAccount(mint.publicKey, holder).toBase58(),
  );
  assert.equal(burn.keys.mint.pubkey.toBase58(), mint.publicKey.toBase58());
  assert.equal(
    burn.keys.owner.pubkey.toBase58(),
    organizer.publicKey.toBase58(),
  );
  assert.equal(burn.keys.owner.isSigner, true);
  assert.equal(burn.data.amount, 1n);
  assert.equal(burn.data.decimals, 0);
});

test("DEVNET_GENESIS_HASH is devnet's genesis hash", () => {
  // getGenesisHash read from api.devnet.solana.com on 2026-11-28. The other tests build their
  // stand-in connections from the constant, so only this literal catches a wrong value in it.
  assert.equal(
    DEVNET_GENESIS_HASH,
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
});

test("a cluster whose genesis hash is not devnet's is refused", async () => {
  const fake = (hash: string) => () =>
    ({ getGenesisHash: async () => hash }) as unknown as Connection;
  await assert.rejects(
    connectDevnet(
      "https://api.devnet.solana.com",
      fake("SomeOtherGenesisHash1111111111111111111111"),
    ),
    {
      message:
        /^SOLANA_RPC_URL is not devnet: its genesis hash is SomeOtherGenesisHash1+\. limen runs on devnet only \(D-03\)\.$/,
    },
  );
  const ok = await connectDevnet(
    "https://api.devnet.solana.com",
    fake(DEVNET_GENESIS_HASH),
  );
  assert.equal(typeof ok.getGenesisHash, "function");
});

test("connectDevnet refuses a URL that is not the allowlisted devnet endpoint before any connection is made", async () => {
  let made = 0;
  const make = () => {
    made += 1;
    return {
      getGenesisHash: async () => DEVNET_GENESIS_HASH,
    } as unknown as Connection;
  };
  for (const url of [
    "http://127.0.0.1:8899",
    "http://api.devnet.solana.com",
    "https://api.devnet.solana.com/",
    "https://api.devnet.solana.com.example.test",
  ]) {
    await assert.rejects(
      connectDevnet(url, make),
      {
        message:
          "SOLANA_RPC_URL must be https://api.devnet.solana.com, the one devnet endpoint limen calls (D-03); unset, it is used.",
      },
      url,
    );
  }
  assert.equal(made, 0);
});

/** A genesis hash that is not devnet's. A stand-in, so no other cluster's value is in the repo. */
const NOT_DEVNET = "SomeOtherGenesisHash1111111111111111111111";
const NOT_DEVNET_MESSAGE =
  /^SOLANA_RPC_URL is not devnet: its genesis hash is SomeOtherGenesisHash1+\. limen runs on devnet only \(D-03\)\.$/;

/**
 * A stand-in connection for mintPass and revokePass: it answers getGenesisHash with `genesis`,
 * prices rent, accepts sends and confirms them, and records each call in order.
 */
function recordingConnection(genesis: string) {
  const calls: string[] = [];
  const answer =
    <T>(name: string, value: T) =>
    async (): Promise<T> => {
      calls.push(name);
      return value;
    };
  const connection = {
    getGenesisHash: answer("getGenesisHash", genesis),
    getMinimumBalanceForRentExemption: answer(
      "getMinimumBalanceForRentExemption",
      4_181_760,
    ),
    sendTransaction: answer("sendTransaction", "stand-in-signature"),
    sendRawTransaction: answer("sendRawTransaction", "stand-in-signature"),
    confirmTransaction: answer("confirmTransaction", {
      context: { slot: 1 },
      value: { err: null },
    }),
  } as unknown as Connection;
  return { connection, calls };
}

test("mintPass and revokePass refuse a cluster whose genesis hash is not devnet's, before anything is sent (D-03)", async () => {
  const minting = recordingConnection(NOT_DEVNET);
  await assert.rejects(
    mintPass(minting.connection, organizer, holder, DETAILS),
    {
      message: NOT_DEVNET_MESSAGE,
    },
  );
  assert.deepEqual(minting.calls, ["getGenesisHash"]);

  const revoking = recordingConnection(NOT_DEVNET);
  await assert.rejects(
    revokePass(revoking.connection, organizer, mint.publicKey, holder),
    { message: NOT_DEVNET_MESSAGE },
  );
  assert.deepEqual(revoking.calls, ["getGenesisHash"]);

  // Control: on devnet's genesis hash the same stand-in reaches the send.
  const devnet = recordingConnection(DEVNET_GENESIS_HASH);
  const minted = await mintPass(devnet.connection, organizer, holder, DETAILS);
  assert.equal(minted.signature, "stand-in-signature");
  assert.deepEqual(devnet.calls, [
    "getGenesisHash",
    "getMinimumBalanceForRentExemption",
    "sendTransaction",
    "confirmTransaction",
  ]);
});

test("mintPass creates the pass at the mint keypair it is given", async () => {
  const given = Keypair.generate();
  let sent: Transaction | undefined;
  const connection = {
    getGenesisHash: async () => DEVNET_GENESIS_HASH,
    getMinimumBalanceForRentExemption: async () => 4_181_760,
    sendTransaction: async (tx: Transaction) => {
      sent = tx;
      return "stand-in-signature";
    },
    confirmTransaction: async () => ({
      context: { slot: 1 },
      value: { err: null },
    }),
  } as unknown as Connection;
  const minted = await mintPass(connection, organizer, holder, DETAILS, given);
  assert.equal(minted.mint.toBase58(), given.publicKey.toBase58());
  assert.ok(sent !== undefined);
  assert.equal(
    SystemInstruction.decodeCreateAccount(
      sent.instructions[0]!,
    ).newAccountPubkey.toBase58(),
    given.publicKey.toBase58(),
  );
});
