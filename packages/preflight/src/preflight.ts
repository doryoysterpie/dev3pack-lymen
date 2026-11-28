// Transaction-request pre-flight (E-09): decode, simulate, and decide whether
// signing may go ahead. The network is reached only through the package's own
// JSON-RPC client, at the endpoint given.
//
// Whose wallet: the caller names the user's wallet, and limen pre-flights
// only transactions that wallet pays the fee for. With no wallet named, or
// another wallet as fee payer, the pre-flight stops and yields no summary. The
// summary and the balance change write the role marker "user" in place of the
// wallet's address; a report also marks the other accounts named in
// instructions the wallet signs and has every address scrubbed from the text
// the RPC wrote (marker.ts). So the app and a server produce the same report
// for the same bytes.
//
// From a simulation, limen takes only the run's status and the wallet's SOL
// change, from the run's own balances (the owner's ruling 20a): it reads no
// account before or after the run, only the lookup tables decoding needs.
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
import { scrubAddresses, USER_MARKER, withRoleMarkers } from "./marker.ts";
import { ADDRESS_LOOKUP_TABLE_PROGRAM } from "./programs.ts";
import {
  assertDevnet,
  isPublicKey,
  jsonRpc,
  RpcError,
  type Rpc,
  type RpcEndpoint,
} from "./rpc.ts";
import {
  walletSolChange,
  watchProblem,
  type BalanceChange,
} from "./simulate.ts";
import { parseLookupTable } from "./state.ts";
import {
  summarizeTransaction,
  type Place,
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
      /**
       * The wallet's SOL change, from the run's own balances (simulate.ts);
       * none when the run failed or left the wallet's SOL as it was.
       */
      readonly changes: readonly BalanceChange[];
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
       * The message's account list, in order: static keys, then the
       * addresses loaded from lookup tables, null where a table could not be
       * read. A report marks each address by its index here (toReport).
       */
      readonly accountKeys: readonly (string | null)[];
      /**
       * For an evidence bundle's `recipients` (E-10): every address a
       * decoded effect asks to send SOL or tokens to or give control to (a
       * SOL or token transfer's destination, a delegate, a new authority, a
       * close's or a mint's destination, a new owner program), in the
       * effects' order, from the unmarked decode (bundleLists). It leaves out
       * the wallet, and an address behind a lookup table limen could not
       * read, which is not known. A report (toReport) never holds it: a report marks every
       * account a wallet-signed instruction names, these included.
       */
      readonly recipients: readonly string[];
      /**
       * For an evidence bundle's `program_ids`: every program the message's
       * instructions call, in the order first called. Never in a report.
       */
      readonly programIds: readonly string[];
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
 * The text of what the RPC call threw, for the reason no result is used. A
 * caller's fetch can throw anything, so reading it must not throw in turn.
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

async function loadTables(
  rpc: Rpc,
  transaction: ParsedTransaction,
): Promise<LookupTables> {
  const keys = transaction.message.lookups.map((lookup) => lookup.table);
  const tables = new Map<string, readonly string[]>();
  if (keys.length === 0) return tables;
  const states = await rpc.getAccounts(keys);
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
  endpoint: RpcEndpoint,
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
  try {
    // The package's own JSON-RPC client is the only RPC (rpc.ts).
    const rpc = jsonRpc(endpoint);
    await assertDevnet(rpc);
    tables = await loadTables(rpc, transaction);
    const refused = lookupProblem(transaction, tables);
    if (refused !== null) return { kind: "malformed", problem: refused };
    const accounts = messageAccounts(transaction.message, tables);
    // The simulation is used only when its evidence covers every account the
    // transaction can write and belongs to this transaction alone; otherwise
    // it is marked not used, which holds signing (signBlocks).
    const unresolved = watchProblem(accounts);
    if (unresolved !== null) throw new Error(unresolved);
    // limen reads no account before or after the run (ruling 20a): it asks
    // for none, and takes the wallet's SOL from the run's own balances.
    const result = await rpc.simulate(base64);
    // From a failed run, limen uses nothing but its error (ruling 20a): no
    // balances, no accounts and no blockhash. agave returns every account
    // of a failed run as null (anza-xyz/agave a64fa73, rpc/src/rpc.rs:3554
    // and :3555), which shows nothing the transaction would do. The slot is
    // the answer's context, not the run's.
    if (result.err !== null) {
      simulation = {
        status: "ran",
        // The runtime's error, with any address the RPC wrote into it
        // scrubbed.
        err: scrubAddresses(result.err),
        changes: [],
      };
      simulatedAt = { slot: result.slot, blockhash: null };
    } else {
      const keys = accounts.map((account) => account.address);
      const { preBalances, postBalances } = result;
      if (
        preBalances === null ||
        postBalances === null ||
        preBalances.length !== keys.length ||
        postBalances.length !== keys.length
      ) {
        throw new Error(
          "the simulation did not return the balances of its own run",
        );
      }
      // The run's keys must be the message's: the addresses it loaded from
      // lookup tables are the ones limen read from them, in order (the
      // owner's ruling 20a), so its balances match the keys limen knows.
      const loaded = accounts.filter((account) => account.lookup !== null);
      const same = (a: readonly (string | null)[], b: readonly string[]) =>
        a.length === b.length && a.every((address, i) => address === b[i]);
      if (
        result.loadedAddresses === null ||
        !same(
          loaded.filter((a) => a.writable).map((a) => a.address),
          result.loadedAddresses.writable,
        ) ||
        !same(
          loaded.filter((a) => !a.writable).map((a) => a.address),
          result.loadedAddresses.readonly,
        )
      ) {
        // The table read is disputed, so no entry of any lookup is taken
        // for the decode, the card or the bundle, as for a table limen
        // could not read (the audit of 21e1f9f, item 4).
        tables = new Map();
        throw new Error(
          "the simulation's loaded addresses do not match the lookup tables read",
        );
      }
      simulation = {
        status: "ran",
        err: null,
        changes: walletSolChange(USER_MARKER, preBalances, postBalances),
      };
      // A blockhash is 32 bytes, and never one of the transaction's own
      // accounts; any other value from the RPC is not kept.
      const blockhash =
        isPublicKey(result.replacementBlockhash) &&
        !keys.includes(result.replacementBlockhash)
          ? result.replacementBlockhash
          : null;
      simulatedAt = { slot: result.slot, blockhash };
    }
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
  const accountKeys = messageAccounts(transaction.message, tables).map(
    (account) => account.address,
  );
  return {
    kind: "ready",
    base64,
    transaction,
    feePayerSet: unset !== null,
    summary,
    simulation,
    blocks: signBlocks(summary, simulation),
    simulatedAt,
    accountKeys,
    ...bundleLists(transaction, summary),
  };
}

/**
 * The recipients and program IDs an evidence bundle carries (Preflight, ready),
 * from the decoded summary before any marker is written: the summary holds
 * every address but the wallet's, which it writes as USER_MARKER.
 */
function bundleLists(
  transaction: ParsedTransaction,
  summary: TransactionSummary,
): { recipients: string[]; programIds: string[] } {
  const recipients: string[] = [];
  const add = (address: string) => {
    if (address !== USER_MARKER && !recipients.includes(address)) {
      recipients.push(address);
    }
  };
  const addPlace = (place: Place) => {
    if ("address" in place) add(place.address);
  };
  for (const effect of summary.effects) {
    switch (effect.kind) {
      case "sol-out":
        addPlace(effect.to);
        break;
      case "token-out":
        addPlace(effect.destination);
        break;
      case "delegate-approved":
        addPlace(effect.delegate);
        break;
      case "authority-changed":
        if (effect.newAuthority !== null) add(effect.newAuthority);
        break;
      case "account-closed":
        addPlace(effect.destination);
        break;
      case "tokens-minted":
        addPlace(effect.destination);
        break;
      case "owner-assigned":
        add(effect.newOwner);
        break;
      default:
        break;
    }
  }
  const { staticKeys, instructions } = transaction.message;
  const programIds: string[] = [];
  for (const instruction of instructions) {
    const program = staticKeys[instruction.programIdIndex];
    if (!programIds.includes(program)) programIds.push(program);
  }
  return { recipients, programIds };
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
  // A refusal carries no address either: another wallet as fee payer is
  // the message's account 0, and any other address is marked as below.
  if (result.kind !== "ready") {
    return withRoleMarkers(
      result.kind === "user-not-fee-payer"
        ? { kind: result.kind, feePayer: "account 0" }
        : result,
      new Map<string, string>(),
    );
  }
  const { feePayerSet, summary, simulation, blocks } = result;
  // A report carries no address but REPORT_PROGRAMS (the owner's ruling
  // 20a): the wallet is "user", an account of the message is "account N" by
  // its index, a lookup table is "lookup table N", and any other address is
  // "address N" in the order first met (marker.ts, withRoleMarkers).
  const markers = new Map<string, string>([
    [result.transaction.message.staticKeys[0], USER_MARKER],
  ]);
  result.accountKeys.forEach((address, index) => {
    if (address !== null && !markers.has(address)) {
      markers.set(address, `account ${index}`);
    }
  });
  result.transaction.message.lookups.forEach((lookup, index) => {
    if (!markers.has(lookup.table)) {
      markers.set(lookup.table, `lookup table ${index}`);
    }
  });
  return withRoleMarkers(
    { kind: "ready", feePayerSet, summary, simulation, blocks },
    markers,
  );
}

/**
 * For a server holding transaction bytes, such as a stored evidence bundle:
 * simulates on devnet through the JSON-RPC endpoint given and decodes the result into the
 * same report the app's card shows, with drainPattern (drain.ts) applied to
 * it, and the slot the simulation ran at. It keeps no blockhash from the
 * RPC: limen can check it only against the message's accounts, and an RPC
 * could make it one of the wallet's other accounts (the PM's ruling on the
 * re-audit's A4). user is the wallet the report is for: the transaction's
 * fee payer, or the report is a refusal with no summary.
 */
export async function preflightTransaction(
  transaction: Uint8Array,
  options: { readonly endpoint: RpcEndpoint; readonly user: string },
): Promise<{
  summary: PreflightReport;
  drainPattern: boolean;
  simulatedAt: Pick<SimulatedAt, "slot"> | null;
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
    options.endpoint,
    encodeBase64(transaction),
    options.user,
  );
  const summary = toReport(result);
  return {
    summary,
    drainPattern: drainPattern(summary),
    simulatedAt:
      result.kind === "ready" && result.simulatedAt !== null
        ? { slot: result.simulatedAt.slot }
        : null,
  };
}
