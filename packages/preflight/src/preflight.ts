// Transaction-request pre-flight (E-09): decode, simulate, and decide whether
// signing may go ahead. Network calls go through the fetch passed in.
//
// Signing blocks follow the Solana Pay specification (solana-foundation/pay
// 8e1b87c, "POST Response"): the wallet signs only when a signature for its
// account is expected, rejects the transaction when another signer's
// signature is missing, and, for a transaction with no signatures, sets the
// fee payer to its account and the recent blockhash to the latest. limen does
// not rebuild a message, so it blocks an unsigned transaction whose fee payer
// is not the user's wallet, and it replaces only the blockhash.

import { messageAccounts, type LookupTables } from "./accounts.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { ADDRESS_LOOKUP_TABLE_PROGRAM } from "./programs.ts";
import { assertDevnet, RpcError, type Rpc } from "./rpc.ts";
import {
  balanceChanges,
  watchedAddresses,
  type BalanceChange,
} from "./simulate.ts";
import { drainPattern } from "./drain.ts";
import { parseLookupTable } from "./state.ts";
import { summarizeTransaction, type TransactionSummary } from "./summary.ts";
import {
  parseTransaction,
  type ParsedTransaction,
  type WireProblem,
} from "./wire.ts";
import { decodePublicKey } from "./base58.ts";

export type SimulationOutcome =
  | {
      readonly status: "ran";
      /** The runtime error the simulation reported, or null. */
      readonly err: unknown;
      readonly changes: readonly BalanceChange[];
      readonly logs: readonly string[];
    }
  | { readonly status: "not-run"; readonly reason: string };

export type SignBlock =
  "user-not-a-signer" | "cosigner-missing" | "fee-payer-not-user";

export type Preflight =
  | {
      readonly kind: "malformed";
      readonly problem: WireProblem | "not-base64";
    }
  | { readonly kind: "not-devnet" }
  | {
      readonly kind: "ready";
      readonly base64: string;
      readonly transaction: ParsedTransaction;
      readonly summary: TransactionSummary;
      readonly simulation: SimulationOutcome;
      readonly blocks: readonly SignBlock[];
    };

export function signBlocks(summary: TransactionSummary): SignBlock[] {
  const blocks: SignBlock[] = [];
  const { signers } = summary;
  if (!signers.userSigns) blocks.push("user-not-a-signer");
  if (signers.others.some((other) => !other.signed)) {
    blocks.push("cosigner-missing");
  }
  if (signers.unsigned && !signers.userPaysFees) {
    blocks.push("fee-payer-not-user");
  }
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
 * Runs the pre-flight for a base64 transaction and the user's wallet address.
 * When the RPC cannot be reached the decode still comes back, with the
 * simulation marked not run. An endpoint that is not devnet stops it.
 */
export async function preflight(
  rpc: Rpc,
  base64: string,
  user: string,
): Promise<Preflight> {
  const bytes = decodeBase64(base64);
  if (bytes === null) return { kind: "malformed", problem: "not-base64" };
  const parsed = parseTransaction(bytes);
  if (!parsed.ok) return { kind: "malformed", problem: parsed.problem };
  const transaction = parsed.transaction;
  if (decodePublicKey(user) === null) {
    throw new Error("preflight: the user address is not a public key");
  }

  let tables: LookupTables = new Map();
  let simulation: SimulationOutcome;
  try {
    await assertDevnet(rpc);
    tables = await loadTables(rpc, transaction);
    const watched = watchedAddresses(
      user,
      messageAccounts(transaction.message, tables),
    );
    const before = await rpc.getAccounts(watched);
    const result = await rpc.simulate(base64, watched);
    simulation = {
      status: "ran",
      err: result.err,
      changes:
        result.accounts.length === watched.length
          ? balanceChanges(user, watched, before, result.accounts)
          : [],
      logs: result.logs,
    };
  } catch (error) {
    if (error instanceof RpcError && error.reason === "not-devnet") {
      return { kind: "not-devnet" };
    }
    simulation = {
      status: "not-run",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const summary = summarizeTransaction(transaction, user, tables);
  return {
    kind: "ready",
    base64,
    transaction,
    summary,
    simulation,
    blocks: signBlocks(summary),
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
 * The pre-flight as plain JSON data: strings, numbers, booleans, arrays and
 * objects only, with amounts as decimal strings. It drops the parsed
 * transaction and its base64, which only signing needs.
 */
export type PreflightReport =
  | Exclude<Preflight, { kind: "ready" }>
  | {
      readonly kind: "ready";
      readonly user: string;
      readonly summary: TransactionSummary;
      readonly simulation: SimulationOutcome;
      readonly blocks: readonly SignBlock[];
    };

export function toReport(result: Preflight, user: string): PreflightReport {
  if (result.kind !== "ready") return result;
  const { summary, simulation, blocks } = result;
  return { kind: "ready", user, summary, simulation, blocks };
}

/**
 * For a server holding transaction bytes, such as a stored evidence bundle:
 * simulates on devnet through the Rpc given and decodes the result into the
 * same summary the app's card shows, with drainPattern (drain.ts) applied to
 * it. user is the wallet the summary is written for; it defaults to the fee
 * payer, the account a Solana Pay transaction request is built for when the
 * application sets the fee payer as the specification asks.
 */
export async function preflightTransaction(
  transaction: Uint8Array,
  options: { readonly rpc: Rpc; readonly user?: string },
): Promise<{ summary: PreflightReport; drainPattern: boolean }> {
  const parsed = parseTransaction(transaction);
  if (!parsed.ok) {
    const summary: PreflightReport = {
      kind: "malformed",
      problem: parsed.problem,
    };
    return { summary, drainPattern: false };
  }
  const user = options.user ?? parsed.transaction.message.staticKeys[0];
  const result = await preflight(options.rpc, encodeBase64(transaction), user);
  const summary = toReport(result, user);
  return { summary, drainPattern: drainPattern(summary) };
}
