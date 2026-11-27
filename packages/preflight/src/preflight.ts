// Transaction-request pre-flight (E-09): decode, simulate, and decide whether
// signing may go ahead. The network is reached only through the Rpc given.
//
// Whose wallet: the summary is always written for the transaction's fee
// payer, its first required signer, read from the bytes: limen pre-flights
// only transactions the user's wallet pays the fee for. A caller may name the
// wallet it expects; a different one is refused, never summarized. The summary
// and the balance changes write the role marker "user" in place of that
// wallet's address, so the app and a server produce the same report for the
// same bytes, and a report carries no wallet address.
//
// Signing follows the Solana Pay specification (solana-foundation/pay
// 8e1b87c, "POST Response"). The wallet signs only when its signature is
// expected, which holds for the fee payer. It rejects the transaction when
// another signer's signature is missing; limen also blocks signing until a
// simulation has run on devnet without an error. For a
// transaction with no signatures it sets the fee payer to its account, which
// it already is, and the recent blockhash to the latest, which forSigning does.

import { messageAccounts, type LookupTables } from "./accounts.ts";
import { decodePublicKey } from "./base58.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { drainPattern } from "./drain.ts";
import { withMarker } from "./marker.ts";
import { ADDRESS_LOOKUP_TABLE_PROGRAM } from "./programs.ts";
import { assertDevnet, RpcError, type Rpc } from "./rpc.ts";
import {
  balanceChanges,
  watchedAddresses,
  type BalanceChange,
} from "./simulate.ts";
import { parseLookupTable } from "./state.ts";
import { summarizeTransaction, type TransactionSummary } from "./summary.ts";
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
      readonly problem: WireProblem | "not-base64";
    }
  | { readonly kind: "not-devnet" }
  | { readonly kind: "user-not-fee-payer"; readonly feePayer: string }
  | {
      readonly kind: "ready";
      readonly base64: string;
      readonly transaction: ParsedTransaction;
      readonly summary: TransactionSummary;
      readonly simulation: SimulationOutcome;
      readonly blocks: readonly SignBlock[];
      readonly simulatedAt: SimulatedAt | null;
    };

export function signBlocks(
  summary: TransactionSummary,
  simulation: SimulationOutcome,
): SignBlock[] {
  const blocks: SignBlock[] = [];
  if (summary.signers.others.some((other) => !other.signed)) {
    blocks.push("cosigner-missing");
  }
  if (simulation.status === "not-run") blocks.push("simulation-not-run");
  else if (simulation.err !== null) blocks.push("simulation-failed");
  return blocks;
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
 * Runs the pre-flight for a base64 transaction. user, when given, is the
 * wallet the caller expects; a transaction whose fee payer is another wallet
 * is refused. When the RPC cannot be reached the decode still comes back, with
 * the simulation marked not run. An endpoint that is not devnet stops it.
 */
export async function preflight(
  rpc: Rpc,
  base64: string,
  user?: string,
): Promise<Preflight> {
  const bytes = decodeBase64(base64);
  if (bytes === null) return { kind: "malformed", problem: "not-base64" };
  const parsed = parseTransaction(bytes);
  if (!parsed.ok) return { kind: "malformed", problem: parsed.problem };
  const transaction = parsed.transaction;
  // wire.ts guarantees at least one static key and one required signer.
  const feePayer = transaction.message.staticKeys[0];
  if (user !== undefined && user !== feePayer) {
    return { kind: "user-not-fee-payer", feePayer };
  }

  let tables: LookupTables = new Map();
  let simulation: SimulationOutcome;
  let simulatedAt: SimulatedAt | null = null;
  try {
    await assertDevnet(rpc);
    tables = await loadTables(rpc, transaction);
    const watched = watchedAddresses(
      feePayer,
      messageAccounts(transaction.message, tables),
    );
    const before = await rpc.getAccounts(watched);
    const result = await rpc.simulate(base64, watched);
    simulation = {
      status: "ran",
      err: result.err,
      // Like the summary, the changes name the user's wallet by its role.
      changes:
        result.accounts.length === watched.length
          ? withMarker(
              balanceChanges(feePayer, watched, before, result.accounts),
              feePayer,
            )
          : [],
    };
    simulatedAt = { slot: result.slot, blockhash: result.replacementBlockhash };
  } catch (error) {
    if (error instanceof RpcError && error.reason === "not-devnet") {
      return { kind: "not-devnet" };
    }
    simulation = {
      status: "not-run",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const summary = summarizeTransaction(transaction, tables);
  return {
    kind: "ready",
    base64,
    transaction,
    summary,
    simulation,
    blocks: signBlocks(summary, simulation),
    simulatedAt,
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
      readonly summary: TransactionSummary;
      readonly simulation: SimulationOutcome;
      readonly blocks: readonly SignBlock[];
    };

export function toReport(result: Preflight): PreflightReport {
  if (result.kind !== "ready") return result;
  const { summary, simulation, blocks } = result;
  return { kind: "ready", summary, simulation, blocks };
}

/**
 * For a server holding transaction bytes, such as a stored evidence bundle:
 * simulates on devnet through the Rpc given and decodes the result into the
 * same report the app's card shows, with drainPattern (drain.ts) applied to
 * it, and where the simulation ran. user, when given, must be the fee payer.
 */
export async function preflightTransaction(
  transaction: Uint8Array,
  options: { readonly rpc: Rpc; readonly user?: string },
): Promise<{
  summary: PreflightReport;
  drainPattern: boolean;
  simulatedAt: SimulatedAt | null;
}> {
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
