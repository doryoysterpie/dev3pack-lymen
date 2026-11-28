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
import { jsonNumbers, pathKey } from "./json.ts";
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

/** An account as read for its lookup table: owner and data only. */
export interface AccountState {
  readonly owner: string;
  readonly data: Uint8Array;
}

export interface Simulation {
  /** The runtime error, as the RPC reports it (JSON data), or null. */
  readonly err: unknown;
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
  /**
   * The addresses the run loaded from lookup tables, writable then
   * read-only (agave a64fa73, rpc/src/rpc.rs:3612; empty lists for a legacy
   * transaction). Null when the endpoint gives none.
   */
  readonly loadedAddresses: {
    readonly writable: readonly string[];
    readonly readonly: readonly string[];
  } | null;
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

/**
 * A URL as a fetch reports a final URL: without its fragment, and with an
 * empty path written as "/" (https://rpc.example and https://rpc.example/
 * are one URL). Nothing else is rewritten, so an endpoint is to be given as
 * its fetch writes it: a lower-case host, no default port.
 */
function asFetched(url: string): string {
  const hash = url.indexOf("#");
  const bare = hash < 0 ? url : url.slice(0, hash);
  const authorityOnly = /^([a-z][a-z0-9+.-]*:\/\/[^/?]*)(\?.*)?$/i.exec(bare);
  return authorityOnly === null
    ? bare
    : `${authorityOnly[1]}/${authorityOnly[2] ?? ""}`;
}

/** The raw text of a number in a call's result, by its path from there. */
type RawNumber = (path: readonly (string | number)[]) => string | undefined;

/** One JSON-RPC call; its result, parsed from the answer's text. */
async function call(
  endpoint: Required<RpcEndpoint>,
  method: string,
  params: unknown[],
): Promise<unknown> {
  return (await callKeepingNumbers(endpoint, method, params)).result;
}

/**
 * One JSON-RPC call; its result, and the text of each number in it as the
 * answer wrote it (json.ts), for the amounts and slot the client keeps.
 */
async function callKeepingNumbers(
  endpoint: Required<RpcEndpoint>,
  method: string,
  params: unknown[],
): Promise<{ readonly result: unknown; readonly raw: RawNumber }> {
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
  // Provenance (the owner's ruling 20a): only a 200 answer from the
  // endpoint itself is evidence. A fetch follows redirects, and its answer's
  // url is the final one, so an answer from any other address is refused,
  // as is one marked ok with another status.
  if (!answer.ok || answer.status !== 200) {
    throw new RpcError("http", `${method}: HTTP ${answer.status}`);
  }
  if (answer.url === "" || asFetched(answer.url) !== asFetched(endpoint.url)) {
    throw new RpcError(
      "http",
      `${method}: the answer came from another address`,
    );
  }
  const numbers = jsonNumbers(answer.text);
  let body: unknown;
  try {
    if (numbers === null) throw new Error("not JSON");
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
  return {
    result: body.result,
    raw: (path) => numbers?.get(pathKey(["result", ...path])),
  };
}

/** What the pre-flight asks of the endpoint, inside the package only. */
export interface Rpc {
  getGenesisHash(): Promise<string>;
  /** Accounts at the confirmed commitment, in the order asked; null if absent. */
  getAccounts(addresses: readonly string[]): Promise<(AccountState | null)[]>;
  /**
   * Simulates without checking signatures, with the recent blockhash
   * replaced. It asks for no account state: limen reads none (ruling 20a).
   */
  simulate(transactionBase64: string): Promise<Simulation>;
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
 * A lamport amount: a whole number from 0 to the largest u64. A JSON number is
 * taken from its text as the answer wrote it (raw), digit for digit, and one
 * written with a fraction or an exponent is refused, even where JSON.parse
 * rounds it to a whole number (1.0000000000000001 reads as 1). A decimal
 * string is taken as it is. Anything else is refused.
 */
function amountAt(
  value: unknown,
  raw: string | undefined,
  what: string,
): string {
  if (typeof value === "number") {
    if (raw !== undefined && isAmount(raw)) return raw;
    throw new RpcError("shape", `${what}: not a whole amount`);
  }
  if (isAmount(value)) return value;
  throw new RpcError("shape", `${what}: not a whole amount`);
}

/** Each item of a JSON list, read by index into a new array. */
function listOf<T>(
  value: unknown,
  what: string,
  read: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) throw new RpcError("shape", `${what}: not a list`);
  const out: T[] = [];
  for (let i = 0; i < value.length; i += 1) out.push(read(value[i], i));
  return out;
}

function balancesOf(
  value: unknown,
  what: string,
  raw: (index: number) => string | undefined,
): string[] | null {
  if (value === undefined || value === null) return null;
  return listOf(value, what, (item, index) => amountAt(item, raw(index), what));
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
  const { owner, data } = value;
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
  return { owner, data: bytes };
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
): Promise<Simulation> {
  const { result, raw } = await callKeepingNumbers(
    endpoint,
    "simulateTransaction",
    [
      transactionBase64,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      },
    ],
  );
  const value = valueOf(result, "simulateTransaction");
  if (!isRecord(value)) {
    throw new RpcError("shape", "simulateTransaction: value");
  }
  const context = isRecord(result) ? result.context : undefined;
  // A slot that is given must be one; with none given, it is unknown.
  const given = isRecord(context) ? context.slot : undefined;
  // Read from its text, so a slot written with a fraction or an exponent is
  // refused even where JSON.parse rounds it (json.ts).
  const givenText = raw(["context", "slot"]);
  if (
    given !== undefined &&
    (!isSlot(given) ||
      givenText === undefined ||
      !/^(0|[1-9][0-9]*)$/.test(givenText))
  ) {
    throw new RpcError("shape", "simulateTransaction: context slot");
  }
  const slot = given ?? null;
  // A missing err field is not a clean run: it is refused, so the pre-flight
  // marks the simulation not run instead of showing no changes.
  if (!("err" in value)) {
    throw new RpcError("shape", "simulateTransaction: no err field");
  }
  // From a failed run limen uses nothing but its error (ruling 20a): its
  // balances and blockhash are not read, so they cannot refuse it either.
  if (value.err !== null) {
    return {
      // Parsed from the answer's text by this client, so it is JSON data.
      err: value.err,
      slot,
      replacementBlockhash: null,
      preBalances: null,
      postBalances: null,
      loadedAddresses: null,
    };
  }
  const replacement = value.replacementBlockhash;
  // A blockhash is 32 bytes in base58; anything else is not kept.
  const replacementBlockhash =
    isRecord(replacement) && isPublicKey(replacement.blockhash)
      ? replacement.blockhash
      : null;
  return {
    // Parsed from the answer's text by this client, so it is JSON data.
    err: value.err ?? null,
    slot,
    replacementBlockhash,
    preBalances: balancesOf(
      value.preBalances,
      "simulateTransaction: preBalances",
      (index) => raw(["value", "preBalances", index]),
    ),
    postBalances: balancesOf(
      value.postBalances,
      "simulateTransaction: postBalances",
      (index) => raw(["value", "postBalances", index]),
    ),
    loadedAddresses: loadedAddressesOf(value.loadedAddresses),
  };
}

/** A run's loaded addresses: two lists of public keys, or null. */
function loadedAddressesOf(value: unknown): Simulation["loadedAddresses"] {
  if (value === undefined || value === null) return null;
  const keys = (list: unknown, what: string) =>
    listOf(list, what, (item) => {
      if (!isPublicKey(item)) throw new RpcError("shape", `${what}: address`);
      return item;
    });
  if (!isRecord(value)) {
    throw new RpcError("shape", "simulateTransaction: loadedAddresses");
  }
  return {
    writable: keys(value.writable, "simulateTransaction: loadedAddresses"),
    readonly: keys(value.readonly, "simulateTransaction: loadedAddresses"),
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
    simulate: (transactionBase64) =>
      fetchSimulation(checked, transactionBase64),
    latestBlockhash: () => fetchLatestBlockhash(checked),
  };
}

/** The endpoint's latest blockhash, for forSigning. */
export function latestBlockhash(endpoint: RpcEndpoint): Promise<string> {
  return jsonRpc(endpoint).latestBlockhash();
}
