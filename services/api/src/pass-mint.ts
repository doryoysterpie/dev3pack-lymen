// Token-2022 check-in pass (E-06, ruled by D-01: no custom program).
//
// Each pass is its own Token-2022 mint with decimals 0 and a supply of one, created with:
//   - NonTransferable: the holder cannot move it;
//   - PermanentDelegate set to the organizer key, so the organizer can burn it to revoke;
//   - MetadataPointer pointing at the mint itself, which holds TokenMetadata: the name, the
//     symbol, and the station, session and check-in time as additional fields.
// The organizer key is the mint authority and the metadata update authority, and pays for
// everything. Devnet only (D-03): connectDevnet connects only to DEVNET_URL, refusing any other URL
// before a connection is made, and builds the Connection with makeConnection, whose every HTTP
// request fails on a redirect rather than following it (the WebSocket web3.js opens to confirm a
// transaction does not use that fetch). connectDevnet, mintPass, revokePass and
// passMintState each refuse a connection whose own endpoint is not DEVNET_URL, and then one whose
// cluster's genesis hash is not devnet's, before anything is sent.
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
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
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

import {
  DEVNET_ENDPOINT,
  devnetEndpoint,
  requireDevnetEndpoint,
} from "./devnet-endpoint.ts";

/** The one devnet endpoint limen calls (devnet-endpoint.ts). */
export const DEVNET_URL = DEVNET_ENDPOINT;
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

/**
 * The most bytes of UTF-8 a station or session ID may take. The mint transaction is 820 bytes
 * with both IDs empty and grows by one byte for each byte of either, so at this limit it is 948
 * bytes, 284 under Solana's 1232-byte limit; at 206 bytes each it would be too large to send.
 */
export const MAX_PASS_ID_BYTES = 64;

/**
 * The additional metadata fields a pass carries, in the order they are written. A station or
 * session ID over MAX_PASS_ID_BYTES is refused here, so no transaction is built for it.
 */
export function passFields(details: PassDetails): [string, string][] {
  for (const field of ["station", "session"] as const) {
    const bytes = Buffer.byteLength(details[field], "utf8");
    if (bytes > MAX_PASS_ID_BYTES) {
      throw new Error(
        `${field} is ${bytes} bytes of UTF-8; a pass allows at most ${MAX_PASS_ID_BYTES}`,
      );
    }
  }
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

/** Refuses the connection unless its cluster's genesis hash is devnet's (D-03). */
async function requireDevnet(connection: Connection): Promise<void> {
  requireDevnetEndpoint(connection.rpcEndpoint);
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `SOLANA_RPC_URL is not devnet: its genesis hash is ${genesis}. limen runs on devnet only (D-03).`,
    );
  }
}

/**
 * globalThis.fetch, read at each call, with redirect "error": a redirect from the endpoint fails
 * the request rather than being followed, to another host or anywhere else. web3.js's own fetch
 * follows redirects.
 */
export const noRedirectFetch = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => globalThis.fetch(input, { ...init, redirect: "error" })) as typeof fetch;

/**
 * A Connection to `url` whose every HTTP request refuses redirects. connectDevnet makes every
 * Connection limen uses with it, unless a test passes a stand-in.
 */
export function makeConnection(url: string): Connection {
  return new Connection(url, {
    commitment: "confirmed",
    fetch: noRedirectFetch,
  });
}

/**
 * Opens a connection to the devnet endpoint, built by `make` (makeConnection unless a test passes
 * a stand-in). A URL other than DEVNET_URL is refused before any connection is made; a connection
 * whose own endpoint is not DEVNET_URL is refused before any call; and a cluster whose genesis
 * hash is not devnet's is refused after that one call.
 */
export async function connectDevnet(
  url: string = DEVNET_URL,
  make: (url: string) => Connection = makeConnection,
): Promise<Connection> {
  const connection = make(devnetEndpoint(url));
  await requireDevnet(connection);
  return connection;
}

/**
 * Mints one pass to `holder` on devnet, at `mint`'s address: a new keypair unless one is given,
 * as E-05 gives one derived per check-in so a retry targets the same address. Returns the mint,
 * the holder's token account and the signature. Over-long details are refused before the cluster
 * is asked anything, and a connection to any other endpoint or cluster is refused before anything
 * is sent.
 */
export async function mintPass(
  connection: Connection,
  organizer: Keypair,
  holder: PublicKey,
  details: PassDetails,
  mint: Keypair = Keypair.generate(),
): Promise<{ mint: PublicKey; tokenAccount: PublicKey; signature: string }> {
  const space = passAccountLen(details);
  await requireDevnet(connection);
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
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

/**
 * Where a pass stands on chain, read without sending anything: "absent" when no account exists
 * at `mint`, "minted" when it is a Token-2022 mint with a supply of one and `holder`'s associated
 * token account holds that one token, and "other" for anything else. A connection to any other
 * endpoint or cluster than devnet's is refused first.
 */
export async function passMintState(
  connection: Connection,
  mint: PublicKey,
  holder: PublicKey,
): Promise<"absent" | "minted" | "other"> {
  await requireDevnet(connection);
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (info === null) return "absent";
  try {
    const state = await getMint(
      connection,
      mint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    const held = await getAccount(
      connection,
      passTokenAccount(mint, holder),
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    return state.supply === 1n && held.amount === 1n ? "minted" : "other";
  } catch {
    return "other";
  }
}

/**
 * Revokes a pass: the organizer burns the holder's token as permanent delegate. A connection to
 * any other endpoint or cluster than devnet's is refused before anything is sent.
 */
export async function revokePass(
  connection: Connection,
  organizer: Keypair,
  mint: PublicKey,
  holder: PublicKey,
): Promise<string> {
  await requireDevnet(connection);
  const tx = buildRevokeTransaction({
    organizer: organizer.publicKey,
    mint,
    holder,
  });
  return sendAndConfirmTransaction(connection, tx, [organizer]);
}
