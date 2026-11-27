// Token-2022 check-in pass (E-06, ruled by D-01: no custom program).
//
// Each pass is its own Token-2022 mint with decimals 0 and a supply of one, created with:
//   - NonTransferable: the holder cannot move it;
//   - PermanentDelegate set to the organizer key, so the organizer can burn it to revoke;
//   - MetadataPointer pointing at the mint itself, which holds TokenMetadata: the name, the
//     symbol, and the station, session and check-in time as additional fields.
// The organizer key is the mint authority and the metadata update authority, and pays for
// everything. Devnet only (D-03): connectDevnet refuses any cluster whose genesis hash is not
// devnet's.
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createInitializeInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createMintToInstruction,
  createUpdateFieldInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

export const DEVNET_URL = "https://api.devnet.solana.com";
/** getGenesisHash on devnet, read from api.devnet.solana.com on 2026-11-27. */
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const PASS_NAME = "limen check-in pass";
export const PASS_SYMBOL = "LIMEN";
export const PASS_URI = "";
export const PASS_DECIMALS = 0;
export const PASS_EXTENSIONS = [
  ExtensionType.NonTransferable,
  ExtensionType.PermanentDelegate,
  ExtensionType.MetadataPointer,
];

export interface PassDetails {
  readonly station: string;
  readonly session: string;
  /** Unix time in whole seconds. */
  readonly checkedInAt: number;
}

/** The additional metadata fields a pass carries, in the order they are written. */
export function passFields(details: PassDetails): [string, string][] {
  return [
    ["station", details.station],
    ["session", details.session],
    [
      "checked_in_at",
      new Date(details.checkedInAt * 1000).toISOString().replace(".000Z", "Z"),
    ],
  ];
}

/**
 * Byte length of a TokenMetadata value in its Borsh layout: update authority (32), mint (32),
 * name, symbol and uri as u32-length-prefixed UTF-8, then a u32 count of (key, value) pairs, each
 * a pair of u32-length-prefixed UTF-8 strings.
 */
export function tokenMetadataLen(
  name: string,
  symbol: string,
  uri: string,
  fields: [string, string][],
): number {
  const str = (s: string): number => 4 + Buffer.byteLength(s, "utf8");
  return (
    32 +
    32 +
    str(name) +
    str(symbol) +
    str(uri) +
    4 +
    fields.reduce((n, [k, v]) => n + str(k) + str(v), 0)
  );
}

/** Space the mint account takes once its metadata is written: the mint with its fixed extensions plus the TLV entry. */
export function passAccountLen(details: PassDetails): number {
  return (
    getMintLen(PASS_EXTENSIONS) +
    TYPE_SIZE +
    LENGTH_SIZE +
    tokenMetadataLen(PASS_NAME, PASS_SYMBOL, PASS_URI, passFields(details))
  );
}

export function passTokenAccount(
  mint: PublicKey,
  holder: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    holder,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
}

/**
 * The transaction that creates one pass mint and mints its single token to the holder's
 * associated token account. `lamports` must cover rent for passAccountLen(details). The organizer
 * pays and signs; the mint keypair signs its own creation.
 */
export function buildPassMintTransaction(input: {
  organizer: PublicKey;
  mint: PublicKey;
  holder: PublicKey;
  details: PassDetails;
  lamports: number;
}): Transaction {
  const { organizer, mint, holder, details, lamports } = input;
  const programId = TOKEN_2022_PROGRAM_ID;
  const tokenAccount = passTokenAccount(mint, holder);
  const tx = new Transaction();
  tx.feePayer = organizer;
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: organizer,
      newAccountPubkey: mint,
      space: getMintLen(PASS_EXTENSIONS),
      lamports,
      programId,
    }),
    createInitializeNonTransferableMintInstruction(mint, programId),
    createInitializePermanentDelegateInstruction(mint, organizer, programId),
    createInitializeMetadataPointerInstruction(
      mint,
      organizer,
      mint,
      programId,
    ),
    createInitializeMintInstruction(
      mint,
      PASS_DECIMALS,
      organizer,
      null,
      programId,
    ),
    createInitializeInstruction({
      programId,
      metadata: mint,
      updateAuthority: organizer,
      mint,
      mintAuthority: organizer,
      name: PASS_NAME,
      symbol: PASS_SYMBOL,
      uri: PASS_URI,
    }),
    ...passFields(details).map(([field, value]) =>
      createUpdateFieldInstruction({
        programId,
        metadata: mint,
        updateAuthority: organizer,
        field,
        value,
      }),
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      organizer,
      tokenAccount,
      holder,
      mint,
      programId,
    ),
    createMintToInstruction(mint, tokenAccount, organizer, 1, [], programId),
  );
  return tx;
}

/** The transaction in which the organizer, as permanent delegate, burns the holder's pass. */
export function buildRevokeTransaction(input: {
  organizer: PublicKey;
  mint: PublicKey;
  holder: PublicKey;
}): Transaction {
  const tx = new Transaction();
  tx.feePayer = input.organizer;
  tx.add(
    createBurnCheckedInstruction(
      passTokenAccount(input.mint, input.holder),
      input.mint,
      input.organizer,
      1,
      PASS_DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  return tx;
}

/** Opens a connection and refuses it unless the cluster's genesis hash is devnet's. */
export async function connectDevnet(
  url: string = DEVNET_URL,
  make = (u: string) => new Connection(u, "confirmed"),
): Promise<Connection> {
  const connection = make(url);
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `SOLANA_RPC_URL is not devnet: its genesis hash is ${genesis}. limen runs on devnet only (D-03).`,
    );
  }
  return connection;
}

/** Mints one pass to `holder` on devnet. Returns the new mint, the holder's token account and the signature. */
export async function mintPass(
  connection: Connection,
  organizer: Keypair,
  holder: PublicKey,
  details: PassDetails,
): Promise<{ mint: PublicKey; tokenAccount: PublicKey; signature: string }> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(
    passAccountLen(details),
  );
  const tx = buildPassMintTransaction({
    organizer: organizer.publicKey,
    mint: mint.publicKey,
    holder,
    details,
    lamports,
  });
  const signature = await sendAndConfirmTransaction(connection, tx, [
    organizer,
    mint,
  ]);
  return {
    mint: mint.publicKey,
    tokenAccount: passTokenAccount(mint.publicKey, holder),
    signature,
  };
}

/** Revokes a pass: the organizer burns the holder's token as permanent delegate. */
export async function revokePass(
  connection: Connection,
  organizer: Keypair,
  mint: PublicKey,
  holder: PublicKey,
): Promise<string> {
  const tx = buildRevokeTransaction({
    organizer: organizer.publicKey,
    mint,
    holder,
  });
  return sendAndConfirmTransaction(connection, tx, [organizer]);
}
