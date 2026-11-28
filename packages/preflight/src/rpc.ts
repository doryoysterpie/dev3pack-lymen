// Solana JSON-RPC client for the pre-flight (E-09), the package's only RPC.
// A caller gives an RpcEndpoint: the endpoint's URL and a fetch that posts a
// body and resolves to plain data, { ok, status, url, text }. The client
// calls no method on anything it receives: it parses the text itself, then
// copies each value it uses into fresh, checked data, with index loops and
// new Uint8Arrays. No caller can hand the pre-flight its own RPC adapter.
//
// Devnet only (D-03): every pre-flight starts with assertDevnet, which compares
// the endpoint's genesis hash with devnet's and refuses any other cluster.

import { decodePublicKey } from "./base58.ts";
import { decodeBase64 } from "./base64.ts";
import { DEVNET_GENESIS_HASH } from "./programs.ts";

/** What a fetch resolves to: plain data, the body already read as text. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  /** The URL the answer came from, after any redirect. */
  readonly url: string;
  readonly text: string;
}

export type Fetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<FetchResponse>;

/** A Solana JSON-RPC endpoint: where it is, and how to post to it. */
export interface RpcEndpoint {
  readonly url: string;
  readonly fetch: Fetch;
  /** How long each answer may take; RPC_TIMEOUT_MS when left out. */
  readonly timeoutMs?: number;
}

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
  /** The runtime error, as the RPC reports it (JSON data), or null. */
  readonly err: unknown;
  /** Post-simulation state of the requested accounts; null when absent. */
  readonly accounts: readonly (AccountState | null)[];
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let nextId = 1;

/** How long the client waits for each answer, unless told otherwise. */
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

/**
 * A fetch's answer as fresh plain data. Only the four fields are read; an
 * answer without its body as text is refused.
 */
export function readAnswer(answer: unknown): FetchResponse {
  if (typeof answer !== "object" || answer === null) {
    throw new RpcError("shape", "the answer is not an object");
  }
  const { ok, status, url, text } = answer as Record<string, unknown>;
  if (typeof text !== "string") {
    throw new RpcError("shape", "the answer's body is not text");
  }
  return {
    ok: ok === true,
    status: typeof status === "number" ? status : 0,
    url: typeof url === "string" ? url : "",
    text,
  };
}

/** One JSON-RPC call; its result, parsed from the answer's text. */
async function call(
  endpoint: Required<RpcEndpoint>,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const id = nextId;
  nextId += 1;
  const late = () =>
    new RpcError(
      "timeout",
      `the RPC endpoint did not answer within ${endpoint.timeoutMs / 1000} seconds`,
    );
  const answer = readAnswer(
    await withTimeout(
      endpoint.fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
      endpoint.timeoutMs,
      late,
    ),
  );
  if (!answer.ok) {
    throw new RpcError("http", `${method}: HTTP ${answer.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    throw new RpcError("shape", `${method}: not JSON`);
  }
  if (!isRecord(body)) throw new RpcError("shape", `${method}: not an object`);
  // An answer to another request is not evidence for this one.
  if (body.id !== id) {
    throw new RpcError("shape", `${method}: the answer is for another request`);
  }
  if (isRecord(body.error)) {
    const message = body.error.message;
    throw new RpcError(
      "rpc",
      `${method}: ${typeof message === "string" ? message : "an error"}`,
    );
  }
  if (!("result" in body)) throw new RpcError("shape", `${method}: no result`);
  return body.result;
}

/** What the pre-flight asks of the endpoint, inside the package only. */
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
 * Whether a value is a lamport or token amount: a whole number from 0 to the
 * largest u64, as a decimal string with no sign, point, exponent or leading
 * zero.
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

/** Each item of a JSON list, read by index into a new array. */
function listOf<T>(
  value: unknown,
  what: string,
  read: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value)) throw new RpcError("shape", `${what}: not a list`);
  const out: T[] = [];
  for (let i = 0; i < value.length; i += 1) out.push(read(value[i]));
  return out;
}

function balancesOf(value: unknown, what: string): string[] | null {
  if (value === undefined || value === null) return null;
  return listOf(value, what, (item) => amountOf(item, what));
}

function tokenBalancesOf(value: unknown, what: string): TokenBalance[] | null {
  if (value === undefined || value === null) return null;
  return listOf(value, what, (item) => {
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
    data.length !== 2 ||
    data[1] !== "base64" ||
    typeof data[0] !== "string"
  ) {
    throw new RpcError("shape", "account: data is not base64");
  }
  // decodeBase64 writes a new Uint8Array.
  const bytes = decodeBase64(data[0]);
  if (bytes === null) {
    throw new RpcError("shape", "account: data is not base64");
  }
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
  endpoint: Required<RpcEndpoint>,
  addresses: readonly string[],
): Promise<(AccountState | null)[]> {
  const out: (AccountState | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const batch = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const result = await call(endpoint, "getMultipleAccounts", [
      batch,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const states = listOf(
      valueOf(result, "getMultipleAccounts"),
      "getMultipleAccounts",
      accountState,
    );
    if (states.length !== batch.length) {
      throw new RpcError("shape", "getMultipleAccounts: wrong length");
    }
    for (let k = 0; k < states.length; k += 1) out.push(states[k]);
  }
  return out;
}

async function fetchSimulation(
  endpoint: Required<RpcEndpoint>,
  transactionBase64: string,
  addresses: readonly string[],
): Promise<Simulation> {
  const result = await call(endpoint, "simulateTransaction", [
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
  if (!isRecord(value)) {
    throw new RpcError("shape", "simulateTransaction: value");
  }
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
    isRecord(replacement) && isPublicKey(replacement.blockhash)
      ? replacement.blockhash
      : null;
  // A missing err field is not a clean run, and a clean run must return the
  // accounts it was asked for: either answer is refused, so the pre-flight
  // marks the simulation not run instead of showing no changes.
  if (!("err" in value)) {
    throw new RpcError("shape", "simulateTransaction: no err field");
  }
  const accounts = value.accounts;
  let states: (AccountState | null)[] = [];
  if (accounts !== null && accounts !== undefined) {
    states = listOf(accounts, "simulateTransaction: accounts", accountState);
    if (states.length !== addresses.length) {
      throw new RpcError("shape", "simulateTransaction: accounts");
    }
  } else if (value.err === null && addresses.length > 0) {
    throw new RpcError("shape", "simulateTransaction: no accounts");
  }
  return {
    // Parsed from the answer's text by this client, so it is JSON data.
    err: value.err ?? null,
    accounts: states,
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
  endpoint: Required<RpcEndpoint>,
): Promise<string> {
  const result = await call(endpoint, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const value = valueOf(result, "getLatestBlockhash");
  if (!isRecord(value) || !isPublicKey(value.blockhash)) {
    throw new RpcError("shape", "getLatestBlockhash: blockhash");
  }
  return value.blockhash;
}

/**
 * The endpoint as the client uses it, or a refusal: a URL as text, a fetch
 * function, and a time limit that is a positive number when given.
 */
function checkedEndpoint(endpoint: unknown): Required<RpcEndpoint> {
  if (typeof endpoint !== "object" || endpoint === null) {
    throw new RpcError("shape", "not an RPC endpoint");
  }
  const { url, fetch, timeoutMs } = endpoint as Record<string, unknown>;
  if (
    typeof url !== "string" ||
    typeof fetch !== "function" ||
    (timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" || !(timeoutMs > 0)))
  ) {
    throw new RpcError("shape", "not an RPC endpoint");
  }
  return {
    url,
    fetch: fetch as Fetch,
    timeoutMs: (timeoutMs as number | undefined) ?? RPC_TIMEOUT_MS,
  };
}

/**
 * The client for an endpoint, inside the package only. It throws when the
 * endpoint is not one.
 */
export function jsonRpc(endpoint: RpcEndpoint): Rpc {
  const checked = checkedEndpoint(endpoint);
  return {
    async getGenesisHash() {
      const hash = await call(checked, "getGenesisHash", []);
      if (typeof hash !== "string") {
        throw new RpcError("shape", "getGenesisHash: not a string");
      }
      return hash;
    },
    getAccounts: (addresses) => fetchAccounts(checked, addresses),
    simulate: (transactionBase64, addresses) =>
      fetchSimulation(checked, transactionBase64, addresses),
    latestBlockhash: () => fetchLatestBlockhash(checked),
  };
}

/** The endpoint's latest blockhash, for forSigning. */
export function latestBlockhash(endpoint: RpcEndpoint): Promise<string> {
  return jsonRpc(endpoint).latestBlockhash();
}
