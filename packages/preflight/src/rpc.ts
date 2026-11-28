// Solana RPC for the pre-flight (E-09). The pre-flight talks to an Rpc, not to
// the network: jsonRpc(fetch, url) is the JSON-RPC implementation, and a test
// or a server can pass any other Rpc, such as recordedRpc (recorded.ts).
//
// Devnet only (D-03): every pre-flight starts with assertDevnet, which compares
// the endpoint's genesis hash with devnet's and refuses any other cluster.

import { decodePublicKey } from "./base58.ts";
import { decodeBase64 } from "./base64.ts";
import { DEVNET_GENESIS_HASH } from "./programs.ts";

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type Fetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<FetchResponse>;

export interface AccountState {
  readonly lamports: string;
  readonly owner: string;
  readonly data: Uint8Array;
}

/** A token account's balance as the simulation reports it, by account index. */
export interface TokenBalance {
  /** The account's index in the transaction's account list. */
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner: string | null;
  /** In base units, as a decimal string. */
  readonly amount: string;
}

export interface Simulation {
  /** The runtime error, as the RPC reports it, or null when it ran clean. */
  readonly err: unknown;
  readonly logs: readonly string[];
  /** Post-simulation state of the requested accounts; null when absent. */
  readonly accounts: readonly (AccountState | null)[];
  readonly unitsConsumed: number | null;
  /** The slot the simulation ran at, from the response context. */
  readonly slot: number | null;
  /** The blockhash the simulation used in place of the transaction's own. */
  readonly replacementBlockhash: string | null;
  /**
   * Lamports of every account in the transaction's account list, before and
   * after, from the simulation's own run (anza-xyz/agave a64fa73,
   * rpc-client-types/src/response.rs:467 to 470, filled from
   * bank.simulate_transaction in rpc/src/rpc.rs:3515 to 3531). Null when the
   * endpoint gives none.
   */
  readonly preBalances: readonly string[] | null;
  readonly postBalances: readonly string[] | null;
  readonly preTokenBalances: readonly TokenBalance[] | null;
  readonly postTokenBalances: readonly TokenBalance[] | null;
}

export class RpcError extends Error {
  readonly reason: "not-devnet" | "http" | "rpc" | "shape" | "timeout";
  constructor(reason: RpcError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The RPC caps getMultipleAccounts at 100 addresses. */
const MAX_ACCOUNTS_PER_CALL = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let nextId = 1;

/** How long jsonRpc waits for each answer, unless told otherwise. */
export const RPC_TIMEOUT_MS = 10_000;

interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/**
 * Settles as the promise does, or rejects with error() once ms have passed.
 * The timers come from the runtime (Node or React Native), not from this
 * package's type library.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  error: () => Error,
): Promise<T> {
  const timers = globalThis as unknown as Timers;
  return new Promise<T>((resolve, reject) => {
    const id = timers.setTimeout(() => reject(error()), ms);
    promise.then(
      (value) => {
        timers.clearTimeout(id);
        resolve(value);
      },
      (reason: unknown) => {
        timers.clearTimeout(id);
        reject(reason);
      },
    );
  });
}

/** A fetch whose answer and body each must arrive within ms. */
function timedFetch(fetch: Fetch, ms: number): Fetch {
  const late = () =>
    new RpcError(
      "timeout",
      `the RPC endpoint did not answer within ${ms / 1000} seconds`,
    );
  return async (url, init) => {
    const response = await withTimeout(fetch(url, init), ms, late);
    return {
      ok: response.ok,
      status: response.status,
      json: () => withTimeout(response.json(), ms, late),
    };
  };
}

async function call(
  fetch: Fetch,
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const id = nextId;
  nextId += 1;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) {
    throw new RpcError("http", `${method}: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!isRecord(body)) throw new RpcError("shape", `${method}: not an object`);
  // An answer to another request is not evidence for this one.
  if (body.id !== id) {
    throw new RpcError("shape", `${method}: the answer is for another request`);
  }
  if (isRecord(body.error)) {
    throw new RpcError("rpc", `${method}: ${String(body.error.message)}`);
  }
  if (!("result" in body)) throw new RpcError("shape", `${method}: no result`);
  return body.result;
}

/** What the pre-flight asks of an RPC endpoint. */
export interface Rpc {
  getGenesisHash(): Promise<string>;
  /** Accounts at the confirmed commitment, in the order asked; null if absent. */
  getAccounts(addresses: readonly string[]): Promise<(AccountState | null)[]>;
  /**
   * Simulates without checking signatures, with the recent blockhash replaced,
   * and reads back the named accounts after it.
   */
  simulate(
    transactionBase64: string,
    addresses: readonly string[],
  ): Promise<Simulation>;
  latestBlockhash(): Promise<string>;
}

/** Refuses any endpoint whose genesis hash is not devnet's. */
export async function assertDevnet(rpc: Rpc): Promise<void> {
  if ((await rpc.getGenesisHash()) !== DEVNET_GENESIS_HASH) {
    throw new RpcError("not-devnet", "the RPC endpoint is not devnet");
  }
}

const U64_MAX = BigInt("18446744073709551615");

/**
 * Whether a value is a lamport or token amount as the Rpc interface carries
 * it: a whole number from 0 to the largest u64, as a decimal string with no
 * sign, point, exponent or leading zero.
 */
export function isAmount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= U64_MAX
  );
}

/**
 * A lamport or token amount: a whole number from 0 to the largest u64, as a
 * JSON number no larger than 2^53 (past it, precision is already lost) or as
 * a decimal string. Anything else is refused.
 */
function amountOf(value: unknown, what: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (isAmount(value)) return value;
  throw new RpcError("shape", `${what}: not a whole amount`);
}

function balancesOf(value: unknown, what: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new RpcError("shape", `${what}: not a list`);
  return value.map((item) => amountOf(item, what));
}

function tokenBalancesOf(value: unknown, what: string): TokenBalance[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new RpcError("shape", `${what}: not a list`);
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item.uiTokenAmount)) {
      throw new RpcError("shape", `${what}: entry`);
    }
    const { accountIndex, mint, owner } = item;
    if (
      typeof accountIndex !== "number" ||
      !Number.isSafeInteger(accountIndex) ||
      accountIndex < 0 ||
      !isPublicKey(mint) ||
      (owner !== undefined && owner !== null && !isPublicKey(owner))
    ) {
      throw new RpcError("shape", `${what}: entry`);
    }
    return {
      accountIndex,
      mint,
      owner: typeof owner === "string" ? owner : null,
      amount: amountOf(item.uiTokenAmount.amount, what),
    };
  });
}

/** Whether a value is a public key: base58 for 32 bytes. */
export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && decodePublicKey(value) !== null;
}

/** Whether a value is a slot: a whole number from 0, as a JSON number. */
export function isSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function accountState(value: unknown): AccountState | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new RpcError("shape", "account: not an object");
  const { lamports, owner, data } = value;
  if (!isPublicKey(owner)) throw new RpcError("shape", "account: owner");
  if (
    !Array.isArray(data) ||
    data[1] !== "base64" ||
    typeof data[0] !== "string"
  ) {
    throw new RpcError("shape", "account: data is not base64");
  }
  const bytes = decodeBase64(data[0]);
  if (bytes === null)
    throw new RpcError("shape", "account: data is not base64");
  return {
    lamports: amountOf(lamports, "account: lamports"),
    owner,
    data: bytes,
  };
}

function valueOf(result: unknown, method: string): unknown {
  if (!isRecord(result) || !("value" in result)) {
    throw new RpcError("shape", `${method}: no value`);
  }
  return result.value;
}

async function fetchAccounts(
  fetch: Fetch,
  url: string,
  addresses: readonly string[],
): Promise<(AccountState | null)[]> {
  const out: (AccountState | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const batch = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const result = await call(fetch, url, "getMultipleAccounts", [
      batch,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const value = valueOf(result, "getMultipleAccounts");
    if (!Array.isArray(value) || value.length !== batch.length) {
      throw new RpcError("shape", "getMultipleAccounts: wrong length");
    }
    out.push(...value.map(accountState));
  }
  return out;
}

async function fetchSimulation(
  fetch: Fetch,
  url: string,
  transactionBase64: string,
  addresses: readonly string[],
): Promise<Simulation> {
  const result = await call(fetch, url, "simulateTransaction", [
    transactionBase64,
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses },
    },
  ]);
  const value = valueOf(result, "simulateTransaction");
  if (!isRecord(value))
    throw new RpcError("shape", "simulateTransaction: value");
  const context = isRecord(result) ? result.context : undefined;
  // A slot that is given must be one; with none given, it is unknown.
  const given = isRecord(context) ? context.slot : undefined;
  if (given !== undefined && !isSlot(given)) {
    throw new RpcError("shape", "simulateTransaction: context slot");
  }
  const slot = given ?? null;
  const replacement = value.replacementBlockhash;
  // A blockhash is 32 bytes in base58; anything else is not kept.
  const replacementBlockhash =
    isRecord(replacement) &&
    typeof replacement.blockhash === "string" &&
    decodePublicKey(replacement.blockhash) !== null
      ? replacement.blockhash
      : null;
  // A missing err field is not a clean run, and a clean run must return the
  // accounts it was asked for: either answer is refused, so the pre-flight
  // marks the simulation not run instead of showing no changes.
  if (!("err" in value)) {
    throw new RpcError("shape", "simulateTransaction: no err field");
  }
  const accounts = value.accounts;
  if (accounts !== null && accounts !== undefined) {
    if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
      throw new RpcError("shape", "simulateTransaction: accounts");
    }
  } else if (value.err === null && addresses.length > 0) {
    throw new RpcError("shape", "simulateTransaction: no accounts");
  }
  const logs = Array.isArray(value.logs)
    ? value.logs.filter((line): line is string => typeof line === "string")
    : [];
  return {
    err: value.err ?? null,
    logs,
    accounts: Array.isArray(accounts) ? accounts.map(accountState) : [],
    unitsConsumed:
      typeof value.unitsConsumed === "number" ? value.unitsConsumed : null,
    slot,
    replacementBlockhash,
    preBalances: balancesOf(
      value.preBalances,
      "simulateTransaction: preBalances",
    ),
    postBalances: balancesOf(
      value.postBalances,
      "simulateTransaction: postBalances",
    ),
    preTokenBalances: tokenBalancesOf(
      value.preTokenBalances,
      "simulateTransaction: preTokenBalances",
    ),
    postTokenBalances: tokenBalancesOf(
      value.postTokenBalances,
      "simulateTransaction: postTokenBalances",
    ),
  };
}

async function fetchLatestBlockhash(
  fetch: Fetch,
  url: string,
): Promise<string> {
  const result = await call(fetch, url, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const value = valueOf(result, "getLatestBlockhash");
  if (!isRecord(value) || typeof value.blockhash !== "string") {
    throw new RpcError("shape", "getLatestBlockhash: blockhash");
  }
  return value.blockhash;
}

/**
 * The Rpc that calls a JSON-RPC endpoint through the fetch passed in. Each
 * answer must arrive within timeoutMs, or the call fails with a timeout.
 */
export function jsonRpc(
  untimed: Fetch,
  url: string,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Rpc {
  const fetch = timedFetch(untimed, timeoutMs);
  return {
    async getGenesisHash() {
      const hash = await call(fetch, url, "getGenesisHash", []);
      if (typeof hash !== "string") {
        throw new RpcError("shape", "getGenesisHash: not a string");
      }
      return hash;
    },
    getAccounts: (addresses) => fetchAccounts(fetch, url, addresses),
    simulate: (transactionBase64, addresses) =>
      fetchSimulation(fetch, url, transactionBase64, addresses),
    latestBlockhash: () => fetchLatestBlockhash(fetch, url),
  };
}
