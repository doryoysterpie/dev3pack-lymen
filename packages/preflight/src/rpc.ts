// Solana JSON-RPC client for the pre-flight (E-09), the package's only RPC.
// A caller gives an RpcEndpoint: the endpoint's URL and a fetch that posts a
// body and resolves to plain data, { ok, status, url, text }. The client
// calls no method on anything it receives: it parses the text itself, then
// copies each value it uses into fresh, checked data, with index loops and
// new Uint8Arrays. No caller can hand the pre-flight its own RPC adapter.
//
// Every answer is read once, by json.ts, which refuses a repeated member name
// at any depth and keeps each number as the text the answer wrote; every
// value the client uses comes from that one read, checked against the shape
// agave gives each method's answer (the owner's audit of 6c4e64e, Majors 1, 3
// and 4). Anything else is refused, which leaves the simulation unused and
// holds signing.
//
// Devnet only (D-03): every pre-flight starts with assertDevnet, which
// confirms devnet only by its exact genesis hash (Major 9).

import { decodePublicKey } from "./base58.ts";
import { decodeBase64 } from "./base64.ts";
import { runError, type RunError } from "./failure.ts";
import {
  isJsonArray,
  isJsonObject,
  JsonNumber,
  parseJson,
  wholeNumber,
  wholeUpTo,
  type JsonObject,
  type JsonValue,
} from "./json.ts";
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
  /** The runtime error as far as limen shows it (failure.ts), or null. */
  readonly err: RunError | null;
  /** The slot from the response context. */
  readonly slot: number;
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
  /**
   * The account index of every token balance entry the run lists. limen uses
   * no token balance, but an entry present must be as agave writes one, and
   * its index is checked against the message's keys (the audits of 21e1f9f,
   * item 5, and of 6c4e64e, Major 3). Empty for a failed run.
   */
  readonly tokenAccountIndexes: readonly number[];
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
    status:
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? status
        : 0,
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

/** One JSON-RPC call; its result, as json.ts read it from the answer's text. */
async function call(
  endpoint: Required<RpcEndpoint>,
  method: string,
  params: unknown[],
): Promise<JsonValue> {
  const id = nextId;
  nextId += 1;
  const late = new RpcError(
    "timeout",
    `the RPC endpoint did not answer within ${endpoint.timeoutMs / 1000} seconds`,
  );
  // What a fetch rejects with, or throws, is never read (the owner's ruling
  // 20a, item 8): no String(), no message, no property. It is compared only
  // by identity with this client's own time limit, and anything else gives
  // a fixed reason.
  let received: unknown;
  try {
    received = await withTimeout(
      endpoint.fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
      endpoint.timeoutMs,
      () => late,
    );
  } catch (error) {
    throw error === late
      ? late
      : new RpcError("http", `${method}: the endpoint could not be reached`);
  }
  const answer = readAnswer(received);
  // Provenance (the owner's ruling 20a; the audit of ac1ce67, Major 2): only
  // a 200 answer from the endpoint itself is evidence. A fetch follows
  // redirects, and its answer's url is the final one, so an answer from
  // another address is refused, while one with no final URL or HTTP status
  // says limen could not confirm or tell.
  if (answer.status === 0) {
    throw new RpcError(
      "http",
      `${method}: the answer gave no HTTP status, so limen could not tell whether it succeeded`,
    );
  }
  if (answer.status !== 200) {
    throw new RpcError("http", `${method}: HTTP ${answer.status}`);
  }
  if (!answer.ok) {
    throw new RpcError(
      "http",
      `${method}: the answer was not marked ok, so limen could not tell whether it succeeded`,
    );
  }
  if (answer.url === "") {
    throw new RpcError(
      "http",
      `${method}: the answer gave no final URL, so limen could not confirm where the answer came from`,
    );
  }
  if (asFetched(answer.url) !== asFetched(endpoint.url)) {
    throw new RpcError(
      "http",
      `${method}: the answer came from another address`,
    );
  }
  // The one read of the answer: a member name repeated at any depth, or
  // text that is not JSON, leaves nothing to read (the audit of 6c4e64e,
  // Major 1).
  const parsed = parseJson(answer.text);
  if (!parsed.ok) {
    throw new RpcError(
      "shape",
      parsed.problem === "repeated-member"
        ? `${method}: a member name repeats`
        : `${method}: not JSON`,
    );
  }
  const body = parsed.value;
  if (!isJsonObject(body)) {
    throw new RpcError("shape", `${method}: not an object`);
  }
  // The envelope as the answer wrote it (the audit of 21e1f9f, item 6).
  if (body.get("jsonrpc") !== "2.0") {
    throw new RpcError("shape", `${method}: not a JSON-RPC 2.0 answer`);
  }
  // An answer to another request is not evidence for this one. The id is
  // compared as written, since JSON.parse rounds 1.0000000000000001 to 1; an
  // absent or non-numeric id says limen could not tell which request it is for.
  const answered = body.get("id");
  if (!(answered instanceof JsonNumber)) {
    throw new RpcError(
      "shape",
      `${method}: the answer gave no request id limen can read, so limen could not tell which request it is for`,
    );
  }
  if (answered.text !== String(id)) {
    throw new RpcError("shape", `${method}: the answer is for another request`);
  }
  const error = body.get("error");
  if (error !== undefined) {
    if (body.has("result")) {
      throw new RpcError(
        "shape",
        `${method}: an answer with both a result and an error`,
      );
    }
    if (!isJsonObject(error)) {
      throw new RpcError("shape", `${method}: an error that is not an object`);
    }
    // No text the endpoint wrote reaches the card or a report, only the
    // error's code, when it is a whole number as written (the audit of
    // 6c4e64e, Major 5, swept to the RPC's own errors).
    const code = error.get("code");
    const written =
      code instanceof JsonNumber && /^-?(0|[1-9][0-9]{0,18})$/.test(code.text)
        ? code.text
        : null;
    throw new RpcError(
      "rpc",
      written === null
        ? `${method}: the endpoint answered with an error`
        : `${method}: the endpoint answered with JSON-RPC error ${written}`,
    );
  }
  const result = body.get("result");
  if (result === undefined) {
    throw new RpcError("shape", `${method}: no result`);
  }
  return result;
}

/**
 * A Response<T> (agave a64fa73, rpc-client-types/src/response.rs:124 to
 * :127): its context's slot, a u64 written as a whole number (:71 to :75),
 * and its value. Every answer that has a context is read through here, so no
 * context slot goes unchecked (the audit of 6c4e64e, Major 4). A slot past
 * 2^53 is refused too, since the client keeps it as a number.
 */
function response(
  result: JsonValue,
  method: string,
): { readonly slot: number; readonly value: JsonValue } {
  const context = isJsonObject(result) ? result.get("context") : undefined;
  const slot = isJsonObject(context)
    ? wholeUpTo(context.get("slot"), Number.MAX_SAFE_INTEGER)
    : null;
  if (slot === null) throw new RpcError("shape", `${method}: context slot`);
  const value = isJsonObject(result) ? result.get("value") : undefined;
  if (value === undefined) throw new RpcError("shape", `${method}: no value`);
  return { slot, value };
}

/** What the pre-flight asks of the endpoint, inside the package only. */
export interface Rpc {
  /** The endpoint's genesis hash: 32 bytes in base58, or a refusal. */
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

/**
 * Refuses any endpoint whose genesis hash is not devnet's. getGenesisHash
 * has already refused anything but a well-formed 32-byte hash, so this
 * refusal, the only one that says "not devnet", is for another cluster's
 * hash (the audit of 6c4e64e, Major 9).
 */
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

/** A u64 as the answer wrote it, digit for digit, or null. */
function u64Of(value: JsonValue | undefined): string | null {
  const text = wholeNumber(value);
  return text !== null && isAmount(text) ? text : null;
}

/** Each item of a JSON list, read by index into a new array. */
function listOf<T>(
  value: JsonValue | undefined,
  what: string,
  read: (item: JsonValue, index: number) => T,
): T[] {
  if (!isJsonArray(value)) throw new RpcError("shape", `${what}: not a list`);
  const out: T[] = [];
  for (let i = 0; i < value.length; i += 1) out.push(read(value[i], i));
  return out;
}

/**
 * A run's lamport balances, Option<Vec<u64>> (response.rs:467 and :468):
 * each a whole number as the answer wrote it, digit for digit, so one with a
 * fraction or an exponent is refused even where JSON.parse would round it to
 * a whole number. Null when the answer gives none.
 */
function balancesOf(
  value: JsonValue | undefined,
  what: string,
): string[] | null {
  if (value === undefined || value === null) return null;
  return listOf(value, what, (item) => {
    const amount = u64Of(item);
    if (amount === null)
      throw new RpcError("shape", `${what}: not a whole amount`);
    return amount;
  });
}

/** Whether a value is a public key: base58 for 32 bytes. */
export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && decodePublicKey(value) !== null;
}

/**
 * An account as read for its lookup table: an owner that is a public key and
 * data as [base64 text, "base64"] (UiAccount and UiAccountData::Binary, agave a64fa73,
 * account-decoder-client-types/src/lib.rs:19 to :34). null for an account
 * that does not exist.
 */
function accountState(value: JsonValue): AccountState | null {
  if (value === null) return null;
  if (!isJsonObject(value)) {
    throw new RpcError("shape", "account: not an object");
  }
  const owner = value.get("owner");
  if (!isPublicKey(owner)) throw new RpcError("shape", "account: owner");
  const data = value.get("data");
  if (
    !isJsonArray(data) ||
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

async function fetchAccounts(
  endpoint: Required<RpcEndpoint>,
  addresses: readonly string[],
): Promise<(AccountState | null)[]> {
  const out: (AccountState | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const batch = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const { value } = response(
      await call(endpoint, "getMultipleAccounts", [
        batch,
        { encoding: "base64", commitment: "confirmed" },
      ]),
      "getMultipleAccounts",
    );
    const states = listOf(value, "getMultipleAccounts", accountState);
    if (states.length !== batch.length) {
      throw new RpcError("shape", "getMultipleAccounts: wrong length");
    }
    for (let k = 0; k < states.length; k += 1) out.push(states[k]);
  }
  return out;
}

/**
 * A blockhash answer, RpcBlockhash (response.rs:145 to :148): a blockhash
 * of 32 bytes in base58, and lastValidBlockHeight a u64 written as a whole
 * number.
 */
function blockhashOf(value: JsonValue | undefined, what: string): string {
  const blockhash = isJsonObject(value) ? value.get("blockhash") : undefined;
  if (
    !isJsonObject(value) ||
    !isPublicKey(blockhash) ||
    u64Of(value.get("lastValidBlockHeight")) === null
  ) {
    throw new RpcError("shape", `${what}: blockhash`);
  }
  return blockhash;
}

async function fetchSimulation(
  endpoint: Required<RpcEndpoint>,
  transactionBase64: string,
): Promise<Simulation> {
  // RpcSimulateTransactionResult (response.rs:457 to :473), in a Response.
  const { slot, value } = response(
    await call(endpoint, "simulateTransaction", [
      transactionBase64,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      },
    ]),
    "simulateTransaction",
  );
  if (!isJsonObject(value)) {
    throw new RpcError("shape", "simulateTransaction: value");
  }
  // A missing err field is not a clean run: it is refused, so the pre-flight
  // marks the simulation not run instead of showing no changes.
  const err = value.get("err");
  if (err === undefined) {
    throw new RpcError("shape", "simulateTransaction: no err field");
  }
  // From a failed run limen uses nothing but its error (ruling 20a), and of
  // the error only what failure.ts shows exactly: its balances and blockhash
  // are not read, so they cannot refuse it either.
  if (err !== null) {
    return {
      err: runError(err),
      slot,
      replacementBlockhash: null,
      preBalances: null,
      postBalances: null,
      loadedAddresses: null,
      tokenAccountIndexes: [],
    };
  }
  const replacement = value.get("replacementBlockhash");
  return {
    err: null,
    slot,
    // Option<RpcBlockhash>: when given, it must be one.
    replacementBlockhash:
      replacement === undefined || replacement === null
        ? null
        : blockhashOf(replacement, "simulateTransaction: replacementBlockhash"),
    preBalances: balancesOf(
      value.get("preBalances"),
      "simulateTransaction: preBalances",
    ),
    postBalances: balancesOf(
      value.get("postBalances"),
      "simulateTransaction: postBalances",
    ),
    loadedAddresses: loadedAddressesOf(value.get("loadedAddresses")),
    tokenAccountIndexes: [
      ...tokenAccountIndexesOf(
        value.get("preTokenBalances"),
        "simulateTransaction: preTokenBalances",
      ),
      ...tokenAccountIndexesOf(
        value.get("postTokenBalances"),
        "simulateTransaction: postTokenBalances",
      ),
    ],
  };
}

/**
 * Whether an OptionSerializer<String> member is absent, null, or a public
 * key (transaction-status-client-types/src/lib.rs:523 to :532).
 */
function optionalKey(entry: JsonObject, name: string): boolean {
  const value = entry.get(name);
  return value === undefined || value === null || isPublicKey(value);
}

/**
 * Whether a value is a UiTokenAmount (agave a64fa73,
 * account-decoder-client-types/src/token.rs:8 to :13): uiAmount an
 * Option<f64>, absent, null or a finite number; decimals a u8; amount and
 * uiAmountString strings, amount a whole u64.
 */
function isUiTokenAmount(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value)) return false;
  const uiAmount = value.get("uiAmount");
  return (
    (uiAmount === undefined ||
      uiAmount === null ||
      (uiAmount instanceof JsonNumber &&
        Number.isFinite(Number(uiAmount.text)))) &&
    wholeUpTo(value.get("decimals"), 255) !== null &&
    isAmount(value.get("amount")) &&
    typeof value.get("uiAmountString") === "string"
  );
}

/**
 * The account indexes of a run's token balance entries, each entry checked
 * against UiTransactionTokenBalance (transaction-status-client-types
 * /src/lib.rs:519 to :533): accountIndex a u8 written as a whole number, a
 * mint that is a public key, a UiTokenAmount, and an owner and program that
 * are public keys when given. A missing list has none.
 */
function tokenAccountIndexesOf(
  value: JsonValue | undefined,
  what: string,
): number[] {
  if (value === undefined || value === null) return [];
  return listOf(value, what, (item) => {
    const index = isJsonObject(item)
      ? wholeUpTo(item.get("accountIndex"), 255)
      : null;
    if (
      !isJsonObject(item) ||
      index === null ||
      !isPublicKey(item.get("mint")) ||
      !isUiTokenAmount(item.get("uiTokenAmount")) ||
      !optionalKey(item, "owner") ||
      !optionalKey(item, "programId")
    ) {
      throw new RpcError("shape", `${what}: entry`);
    }
    return index;
  });
}

/**
 * A run's loaded addresses, UiLoadedAddresses
 * (transaction-status-client-types/src/lib.rs:480 to :483): two lists of
 * public keys, or null when the answer gives none.
 */
function loadedAddressesOf(
  value: JsonValue | undefined,
): Simulation["loadedAddresses"] {
  if (value === undefined || value === null) return null;
  const what = "simulateTransaction: loadedAddresses";
  if (!isJsonObject(value)) throw new RpcError("shape", what);
  const keys = (list: JsonValue | undefined) =>
    listOf(list, what, (item) => {
      if (!isPublicKey(item)) throw new RpcError("shape", `${what}: address`);
      return item;
    });
  return {
    writable: keys(value.get("writable")),
    readonly: keys(value.get("readonly")),
  };
}

async function fetchLatestBlockhash(
  endpoint: Required<RpcEndpoint>,
): Promise<string> {
  const { value } = response(
    await call(endpoint, "getLatestBlockhash", [{ commitment: "confirmed" }]),
    "getLatestBlockhash",
  );
  return blockhashOf(value, "getLatestBlockhash");
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
    url.length === 0 ||
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
      // A genesis hash is a Hash written as text: 32 bytes in base58
      // (agave a64fa73, rpc/src/rpc.rs:2472 to :2475). Anything else leaves
      // devnet unconfirmed; it is never taken for another cluster (the audit
      // of 6c4e64e, Major 9).
      const hash = await call(checked, "getGenesisHash", []);
      if (!isPublicKey(hash)) {
        throw new RpcError("shape", "getGenesisHash: not a 32-byte hash");
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
