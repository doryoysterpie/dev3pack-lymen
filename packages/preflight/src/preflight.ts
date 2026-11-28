// Transaction-request pre-flight (E-09): decode, simulate, and decide whether
// signing may go ahead. The network is reached only through the Rpc given.
//
// Whose wallet: the caller names the user's wallet, and limen pre-flights
// only transactions that wallet pays the fee for. With no wallet named, or
// another wallet as fee payer, the pre-flight stops and yields no summary. The
// summary and the balance changes write the role marker "user" in place of the
// wallet's address; a report also writes "user token account N" for the
// wallet's token accounts and has every address scrubbed from the text the RPC
// wrote (marker.ts). So the app and a server produce the same report for the
// same bytes, and a report names neither the wallet nor a token account limen
// found to be its own.
//
// Signing follows the Solana Pay specification (solana-foundation/pay
// 8e1b87c, "POST Response"). The wallet signs only when its signature is
// expected, which holds for the fee payer. It rejects the transaction when
// another signer's signature is missing; limen also blocks signing until a
// simulation has run on devnet without an error. For a transaction with no
// signatures the wallet sets the fee payer to its account and the recent
// blockhash to the latest. When such a request leaves the fee payer unset
// (the zero value), limen sets the user's wallet before anything else
// (fee-payer.ts), so the card, the simulation and the signature all cover the
// rebuilt transaction. forSigning sets the blockhash.

import { messageAccounts, type LookupTables } from "./accounts.ts";
import { decodePublicKey } from "./base58.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { drainPattern } from "./drain.ts";
import { readUnsetFeePayer, withFeePayer } from "./fee-payer.ts";
import {
  scrubAddresses,
  scrubWithin,
  USER_AUTHORIZED_TOKEN_ACCOUNT_MARKER,
  USER_TOKEN_ACCOUNT_MARKER,
  withMarker,
  withMarkers,
} from "./marker.ts";
import { ADDRESS_LOOKUP_TABLE_PROGRAM } from "./programs.ts";
import {
  assertDevnet,
  isAmount,
  isPublicKey,
  isSlot,
  RpcError,
  type AccountState,
  type Rpc,
} from "./rpc.ts";
import {
  balanceChanges,
  FROM_READ_BEFORE,
  ownedTokenAccounts,
  unchangedBetween,
  watchedAddresses,
  watchProblem,
  type BalanceChange,
} from "./simulate.ts";
import { parseLookupTable } from "./state.ts";
import {
  summarizeTransaction,
  userAuthorizedTokenAccounts,
  userTokenAccounts,
  type TransactionSummary,
} from "./summary.ts";
import {
  parseTransaction,
  type ParsedTransaction,
  type WireProblem,
} from "./wire.ts";

export type SimulationOutcome =
  | {
      readonly status: "ran";
      /** The runtime error the simulation reported, or null. */
      readonly err: unknown;
      readonly changes: readonly BalanceChange[];
      /**
       * Always FROM_READ_BEFORE (simulate.ts): the fields of the changes
       * taken from a read before the simulation, not simulated.
       */
      readonly fromReadBefore: typeof FROM_READ_BEFORE;
    }
  | { readonly status: "not-run"; readonly reason: string };

/**
 * Where a simulation ran. It is kept out of the summary, because a later
 * simulation of the same bytes runs at another slot.
 */
export interface SimulatedAt {
  /** The slot from the simulateTransaction response context. */
  readonly slot: number | null;
  /** The blockhash simulated against, in place of the transaction's own. */
  readonly blockhash: string | null;
}

/**
 * cosigner-missing: another required signature is missing, which the Solana
 * Pay format has wallets refuse. simulation-not-run and simulation-failed:
 * the card can show only the decode, so signing waits for a simulation that
 * ran on devnet without an error.
 */
export type SignBlock =
  "cosigner-missing" | "simulation-not-run" | "simulation-failed";

export type Preflight =
  | {
      readonly kind: "malformed";
      readonly problem:
        WireProblem | "not-base64" | "not-bytes" | "bad-lookup-index";
    }
  | { readonly kind: "not-devnet" }
  | { readonly kind: "user-not-fee-payer"; readonly feePayer: string }
  /** No wallet was named, or the one named is not a public key. */
  | { readonly kind: "user-not-given" }
  | {
      readonly kind: "ready";
      /** The transaction checked, and the one to sign. */
      readonly base64: string;
      readonly transaction: ParsedTransaction;
      /** True when the request left the fee payer unset and limen set the user. */
      readonly feePayerSet: boolean;
      readonly summary: TransactionSummary;
      readonly simulation: SimulationOutcome;
      readonly blocks: readonly SignBlock[];
      readonly simulatedAt: SimulatedAt | null;
      /**
       * The wallet's token accounts, in the message's account order: those
       * the read before the simulation, or the simulation's own account
       * state, shows it owns. A report writes "user token account N" for the
       * Nth, and the card says "your token account" only for these.
       */
      readonly userTokenAccounts: readonly string[];
      /**
       * Other token accounts the decoded instructions name as the wallet's
       * (summary.ts, userTokenAccounts) or act on with the wallet as signing
       * authority (summary.ts, userAuthorizedTokenAccounts), in the same
       * order: an instruction alone shows no ownership. A report writes
       * "user-authorized token account N".
       */
      readonly userAuthorizedTokenAccounts: readonly string[];
    };

export function signBlocks(
  summary: TransactionSummary,
  simulation: SimulationOutcome,
): SignBlock[] {
  const blocks: SignBlock[] = [];
  if (summary.signers.others.some((other) => !other.signatureFilled)) {
    blocks.push("cosigner-missing");
  }
  if (simulation.status === "not-run") blocks.push("simulation-not-run");
  else if (simulation.err !== null) blocks.push("simulation-failed");
  return blocks;
}

/**
 * What the runtime refuses once the lookup tables are read: an index past the
 * end of a table that was read, or an address loaded twice, once through a
 * lookup. A table that could not be read leaves its addresses unknown.
 */
function lookupProblem(
  transaction: ParsedTransaction,
  tables: LookupTables,
): "bad-lookup-index" | "duplicate-key" | null {
  for (const lookup of transaction.message.lookups) {
    const table = tables.get(lookup.table);
    if (table === undefined) continue;
    const indexes = [...lookup.writableIndexes, ...lookup.readonlyIndexes];
    if (indexes.some((index) => index >= table.length)) {
      return "bad-lookup-index";
    }
  }
  const addresses = messageAccounts(transaction.message, tables)
    .map((account) => account.address)
    .filter((address): address is string => address !== null);
  return new Set(addresses).size === addresses.length ? null : "duplicate-key";
}

/**
 * Any Rpc can be passed in, not only jsonRpc, so each account's owner is
 * checked here as well: an owner that is not a public key is not evidence.
 */
function validStates(
  states: readonly (AccountState | null)[],
  asked?: number,
): readonly (AccountState | null)[] {
  if (
    !Array.isArray(states) ||
    (asked !== undefined && states.length !== asked)
  ) {
    throw new Error("the RPC did not return the accounts asked");
  }
  if (!states.every((state) => state === null || isPublicKey(state?.owner))) {
    throw new Error("an account's owner is not a public key");
  }
  if (
    !states.every((state) => state === null || state.data instanceof Uint8Array)
  ) {
    throw new Error("an account's data is not bytes");
  }
  return states;
}

/**
 * The text of what an Rpc threw, for the reason no result is used. An Rpc
 * can throw anything, so reading it must not throw in turn.
 */
function errorText(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "the RPC failed with an error limen cannot read";
  }
}

function isNotDevnet(error: unknown): boolean {
  try {
    return error instanceof RpcError && error.reason === "not-devnet";
  } catch {
    return false;
  }
}

/**
 * The runtime error as JSON data, for any Rpc: null, booleans, strings,
 * finite numbers, arrays and plain objects, with a bigint written as its
 * decimal string. Anything else, or a cycle, is not evidence, and throws.
 */
function jsonError(value: unknown, seen: readonly object[] = []): unknown {
  const refused = () => new Error("the simulation's error is not JSON data");
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw refused();
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || seen.includes(value)) throw refused();
  const inside = [...seen, value];
  if (Array.isArray(value)) return value.map((item) => jsonError(item, inside));
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw refused();
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonError(item, inside)]),
  );
}

async function loadTables(
  rpc: Rpc,
  transaction: ParsedTransaction,
): Promise<LookupTables> {
  const keys = transaction.message.lookups.map((lookup) => lookup.table);
  const tables = new Map<string, readonly string[]>();
  if (keys.length === 0) return tables;
  const states = validStates(await rpc.getAccounts(keys), keys.length);
  keys.forEach((key, i) => {
    const state = states[i];
    if (state === null || state.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) return;
    const addresses = parseLookupTable(state.data);
    if (addresses !== null) tables.set(key, addresses);
  });
  return tables;
}

/**
 * Runs the pre-flight for a base64 transaction. user is the wallet the caller
 * pre-flights for; with none, or one that is not a public key, the result is
 * user-not-given, and a transaction whose fee payer is another wallet is
 * refused. An unsigned request that leaves the fee payer unset is rebuilt with
 * user as its fee payer. When the RPC cannot be reached the decode still comes
 * back, with the simulation marked not run. An endpoint that is not devnet
 * stops it.
 */
export async function preflight(
  rpc: Rpc,
  sent: string,
  user: string,
): Promise<Preflight> {
  // A JavaScript caller can leave user out; nothing is summarized then.
  if (typeof user !== "string" || decodePublicKey(user) === null) {
    return { kind: "user-not-given" };
  }
  // A JavaScript caller can pass anything; only text can be base64.
  const received = typeof sent === "string" ? decodeBase64(sent) : null;
  if (received === null) return { kind: "malformed", problem: "not-base64" };
  const unset = readUnsetFeePayer(received);
  let bytes = received;
  if (unset !== null) {
    const rebuilt = withFeePayer(unset, user);
    if (!rebuilt.ok) return { kind: "malformed", problem: rebuilt.problem };
    bytes = rebuilt.bytes;
  }
  const base64 = unset !== null ? encodeBase64(bytes) : sent;
  const parsed = parseTransaction(bytes);
  if (!parsed.ok) return { kind: "malformed", problem: parsed.problem };
  const transaction = parsed.transaction;
  // wire.ts guarantees at least one static key and one required signer.
  const feePayer = transaction.message.staticKeys[0];
  if (user !== feePayer) {
    return { kind: "user-not-fee-payer", feePayer };
  }

  let tables: LookupTables = new Map();
  let simulation: SimulationOutcome;
  let simulatedAt: SimulatedAt | null = null;
  let owned: string[] = [];
  // Whether the accounts were read before the simulation; with no read,
  // nothing shows which token accounts are the wallet's.
  let read = false;
  try {
    await assertDevnet(rpc);
    tables = await loadTables(rpc, transaction);
    const refused = lookupProblem(transaction, tables);
    if (refused !== null) return { kind: "malformed", problem: refused };
    const accounts = messageAccounts(transaction.message, tables);
    // The simulation is used only when its evidence covers every account the
    // transaction can write and belongs to this transaction alone; otherwise
    // it is marked not used, which holds signing (signBlocks).
    const unwatched = watchProblem(feePayer, accounts);
    if (unwatched !== null) throw new Error(unwatched);
    const watched = watchedAddresses(feePayer, accounts);
    const before = validStates(await rpc.getAccounts(watched), watched.length);
    read = true;
    owned = ownedTokenAccounts(feePayer, watched, before, []);
    const result = await rpc.simulate(base64, watched);
    validStates(result.accounts);
    if (result.slot !== null && !isSlot(result.slot)) {
      throw new Error("the simulation's slot is not a slot");
    }
    const err = jsonError(result.err);
    if (result.accounts.length !== watched.length) {
      throw new Error(
        `the simulation returned ${result.accounts.length} accounts for the ${watched.length} asked`,
      );
    }
    const keys = accounts.map((account) => account.address);
    const { preBalances, postBalances, preTokenBalances, postTokenBalances } =
      result;
    if (
      preBalances === null ||
      postBalances === null ||
      preTokenBalances === null ||
      postTokenBalances === null ||
      preBalances.length !== keys.length ||
      postBalances.length !== keys.length
    ) {
      throw new Error(
        "the simulation did not return the balances of its own run",
      );
    }
    // Any Rpc can be passed in, not only jsonRpc, so every amount is checked
    // here as well: a balance that is not a whole amount is not used.
    if (
      ![...preBalances, ...postBalances].every(isAmount) ||
      ![...preTokenBalances, ...postTokenBalances].every((balance) =>
        isAmount(balance.amount),
      )
    ) {
      throw new Error(
        "the simulation returned a balance that is not a whole amount",
      );
    }
    // The amounts come from the simulation's own run, except a token
    // account's in a transaction with no token program, which cannot change
    // (simulate.ts, balanceChanges). The other fields come from the read
    // before it, which a second read must confirm, so a change another
    // transaction made in between is not taken for this one's.
    const again = validStates(await rpc.getAccounts(watched), watched.length);
    if (!unchangedBetween(before, again)) {
      throw new Error(
        "an account limen watches changed on devnet during the check",
      );
    }
    owned = ownedTokenAccounts(feePayer, watched, before, result.accounts);
    // A run that failed returns every account as null (anza-xyz/agave
    // a64fa73, rpc/src/rpc.rs:3554 and :3555), which shows nothing the
    // transaction would do, so a failed run lists no change.
    const changes =
      err === null
        ? balanceChanges(feePayer, watched, before, result.accounts, {
            keys,
            pre: preBalances,
            post: postBalances,
            preToken: preTokenBalances,
            postToken: postTokenBalances,
          })
        : [];
    simulation = {
      status: "ran",
      // The runtime's error, with any address the RPC wrote into it scrubbed.
      err: scrubAddresses(err),
      // Like the summary, the changes name the user's wallet by its role.
      changes: withMarker(changes, feePayer),
      fromReadBefore: FROM_READ_BEFORE,
    };
    // A blockhash is 32 bytes, and never one of the transaction's own
    // accounts; any other value from the RPC is not kept.
    const blockhash =
      isPublicKey(result.replacementBlockhash) &&
      !keys.includes(result.replacementBlockhash)
        ? result.replacementBlockhash
        : null;
    simulatedAt = { slot: result.slot, blockhash };
  } catch (error) {
    if (isNotDevnet(error)) return { kind: "not-devnet" };
    // The reason can quote the RPC's own error text, which can name any
    // account, so every address in it is scrubbed.
    simulation = {
      status: "not-run",
      reason: scrubAddresses(errorText(error)),
    };
  }

  const summary = summarizeTransaction(transaction, tables);
  const order = messageAccounts(transaction.message, tables).map(
    (account) => account.address,
  );
  const inOrder = (a: string, b: string) => order.indexOf(a) - order.indexOf(b);
  // The wallet's token accounts are those a read shows it owns. An
  // instruction alone shows no ownership: an account it names as the
  // wallet's is marked as user-authorized instead.
  const tokenAccounts = [...new Set(owned)].sort(inOrder);
  // With no read, a wallet-signed transfer's destination is marked too: it
  // could be another of the wallet's token accounts.
  const authorizedAccounts = [
    ...new Set([
      ...userTokenAccounts(transaction, tables),
      ...userAuthorizedTokenAccounts(transaction, tables, !read),
    ]),
  ]
    .filter((address) => !tokenAccounts.includes(address))
    .sort(inOrder);
  // The RPC's text can hold an address inside a longer run, which the scrub
  // of whole runs leaves; the wallet's own addresses are removed wherever
  // they occur.
  const walletAddresses = [feePayer, ...tokenAccounts, ...authorizedAccounts];
  simulation =
    simulation.status === "ran"
      ? { ...simulation, err: scrubWithin(simulation.err, walletAddresses) }
      : {
          ...simulation,
          reason: scrubWithin(simulation.reason, walletAddresses),
        };
  return {
    kind: "ready",
    base64,
    transaction,
    feePayerSet: unset !== null,
    summary,
    simulation,
    blocks: signBlocks(summary, simulation),
    simulatedAt,
    userTokenAccounts: tokenAccounts,
    userAuthorizedTokenAccounts: authorizedAccounts,
  };
}

/**
 * Signing is allowed only for a ready pre-flight with no blocks, and only once
 * its card has been shown: shownFor is the base64 of the transaction whose
 * card is on screen.
 */
export function signingAllowed(
  result: Preflight,
  shownFor: string | null,
): boolean {
  return (
    result.kind === "ready" &&
    result.blocks.length === 0 &&
    shownFor === result.base64
  );
}

/**
 * The transaction to hand to the wallet. With no signatures in it, the recent
 * blockhash is replaced with the latest one, as the specification has the
 * wallet do. With signatures, it is left as it is.
 */
export function forSigning(
  result: Extract<Preflight, { kind: "ready" }>,
  latestBlockhash: string,
): string {
  if (!result.summary.signers.unsigned) return result.base64;
  const hash = decodePublicKey(latestBlockhash);
  const bytes = decodeBase64(result.base64);
  if (hash === null || bytes === null) {
    throw new Error("forSigning: bad blockhash or transaction");
  }
  const { messageBytes, blockhashOffset } = result.transaction;
  const at = bytes.length - messageBytes.length + blockhashOffset;
  const out = bytes.slice();
  out.set(hash, at);
  return encodeBase64(out);
}

/**
 * The pre-flight as plain JSON data: strings, numbers, booleans, null, arrays
 * and objects only, with amounts as decimal strings. It is what the card
 * shows and what a report carries. It drops the parsed transaction and its
 * base64, which only signing needs, and where the simulation ran, which
 * differs between runs.
 */
export type PreflightReport =
  | Exclude<Preflight, { kind: "ready" }>
  | {
      readonly kind: "ready";
      readonly feePayerSet: boolean;
      readonly summary: TransactionSummary;
      readonly simulation: SimulationOutcome;
      readonly blocks: readonly SignBlock[];
    };

export function toReport(result: Preflight): PreflightReport {
  if (result.kind !== "ready") return result;
  const { feePayerSet, summary, simulation, blocks } = result;
  const markers = new Map([
    ...result.userTokenAccounts.map(
      (address, i) =>
        [address, `${USER_TOKEN_ACCOUNT_MARKER} ${i + 1}`] as const,
    ),
    ...result.userAuthorizedTokenAccounts.map(
      (address, i) =>
        [address, `${USER_AUTHORIZED_TOKEN_ACCOUNT_MARKER} ${i + 1}`] as const,
    ),
  ]);
  return withMarkers(
    { kind: "ready", feePayerSet, summary, simulation, blocks },
    markers,
  );
}

/**
 * For a server holding transaction bytes, such as a stored evidence bundle:
 * simulates on devnet through the Rpc given and decodes the result into the
 * same report the app's card shows, with drainPattern (drain.ts) applied to
 * it, and where the simulation ran. user is the wallet the report is for: the
 * transaction's fee payer, or the report is a refusal with no summary.
 */
export async function preflightTransaction(
  transaction: Uint8Array,
  options: { readonly rpc: Rpc; readonly user: string },
): Promise<{
  summary: PreflightReport;
  drainPattern: boolean;
  simulatedAt: SimulatedAt | null;
}> {
  // A JavaScript caller can pass anything; only bytes are a transaction.
  if (!(transaction instanceof Uint8Array)) {
    return {
      summary: { kind: "malformed", problem: "not-bytes" },
      drainPattern: false,
      simulatedAt: null,
    };
  }
  const result = await preflight(
    options.rpc,
    encodeBase64(transaction),
    options.user,
  );
  const summary = toReport(result);
  return {
    summary,
    drainPattern: drainPattern(summary),
    simulatedAt: result.kind === "ready" ? result.simulatedAt : null,
  };
}
