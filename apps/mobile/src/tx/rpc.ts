// Solana JSON-RPC calls for the pre-flight (E-09). fetch is passed in, so the
// tests run on canned responses and no test needs the network.
//
// Devnet only (D-03): every session starts with assertDevnet, which compares
// the endpoint's genesis hash with devnet's and refuses any other cluster.

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

export interface Simulation {
  /** The runtime error, as the RPC reports it, or null when it ran clean. */
  readonly err: unknown;
  readonly logs: readonly string[];
  /** Post-simulation state of the requested accounts; null when absent. */
  readonly accounts: readonly (AccountState | null)[];
  readonly unitsConsumed: number | null;
}

export class RpcError extends Error {
  readonly reason: "not-devnet" | "http" | "rpc" | "shape";
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
  if (isRecord(body.error)) {
    throw new RpcError("rpc", `${method}: ${String(body.error.message)}`);
  }
  if (!("result" in body)) throw new RpcError("shape", `${method}: no result`);
  return body.result;
}

/** Refuses any endpoint whose genesis hash is not devnet's. */
export async function assertDevnet(fetch: Fetch, url: string): Promise<void> {
  const hash = await call(fetch, url, "getGenesisHash", []);
  if (hash !== DEVNET_GENESIS_HASH) {
    throw new RpcError("not-devnet", "the RPC endpoint is not devnet");
  }
}

function accountState(value: unknown): AccountState | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new RpcError("shape", "account: not an object");
  const { lamports, owner, data } = value;
  if (typeof lamports !== "number" && typeof lamports !== "string") {
    throw new RpcError("shape", "account: lamports");
  }
  if (typeof owner !== "string") throw new RpcError("shape", "account: owner");
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
  // lamports fit in a u64; a JSON number past 2^53 has already lost precision,
  // so such a value is refused rather than shown wrong.
  if (typeof lamports === "number" && !Number.isSafeInteger(lamports)) {
    throw new RpcError("shape", "account: lamports past 2^53");
  }
  return { lamports: String(lamports), owner, data: bytes };
}

function valueOf(result: unknown, method: string): unknown {
  if (!isRecord(result) || !("value" in result)) {
    throw new RpcError("shape", `${method}: no value`);
  }
  return result.value;
}

/** Reads accounts at the confirmed commitment, in the order asked. */
export async function getAccounts(
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

/**
 * Simulates the transaction without checking signatures, with the recent
 * blockhash replaced, and reads back the named accounts after it.
 */
export async function simulate(
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
  const accounts = value.accounts;
  if (accounts !== null && accounts !== undefined) {
    if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
      throw new RpcError("shape", "simulateTransaction: accounts");
    }
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
  };
}

/** The latest blockhash at the confirmed commitment. */
export async function latestBlockhash(
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
