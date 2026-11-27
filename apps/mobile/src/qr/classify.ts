// QR payload type detection (E-04). Pure module: it imports the URL parser
// that Expo installs as the global URL on the device, so the Node done test
// runs the same parser the app runs.
//
// Solana Pay rules follow the Solana Pay specification and its reference
// parseURL in solana-foundation/pay at commit 8e1b87c:
// typescript/packages/solana-pay/spec/SPEC.md and
// typescript/packages/solana-pay/core/src/parseURL.ts. This module is the one
// place that parses a Solana Pay URL; the transfer card (E-08) reads the
// fields it returns.

import { URL } from "whatwg-url-minimum";

import { decodePublicKey } from "./base58.ts";

/** Every station QR starts with this text. E-03 defines what follows it. */
export const STATION_PREFIX = "limen:station:";

/** The reference parseURL refuses a URL string longer than this. */
export const MAX_SOLANA_PAY_LENGTH = 2048;

/** The spec: a SOL amount may carry at most 9 decimal places. */
export const SOL_DECIMALS = 9;

/** Why a solana: URL is malformed. */
export type SolanaPayProblem =
  | "too-long"
  | "query-invalid"
  | "no-pathname"
  | "link-invalid"
  | "recipient-invalid"
  | "duplicate-field"
  | "amount-invalid"
  | "amount-too-precise"
  | "spl-token-invalid"
  | "reference-invalid";

export interface TransferRequest {
  readonly type: "solana-pay";
  readonly request: "transfer";
  readonly recipient: string;
  /** The amount exactly as written, or null when the wallet must ask. */
  readonly amount: string | null;
  readonly splToken: string | null;
  readonly references: readonly string[];
  readonly label: string | null;
  readonly message: string | null;
  readonly memo: string | null;
}

export type QrClass =
  | { readonly type: "station"; readonly text: string }
  | TransferRequest
  | {
      readonly type: "solana-pay";
      readonly request: "transaction";
      readonly link: string;
    }
  | { readonly type: "url"; readonly href: string }
  | { readonly type: "other"; readonly reason: "unrecognized" }
  | {
      readonly type: "other";
      readonly reason: "malformed-solana-pay";
      readonly problem: SolanaPayProblem;
    };

export type OtherReason = Extract<QrClass, { type: "other" }>["reason"];

const UNRECOGNIZED: QrClass = { type: "other", reason: "unrecognized" };

function malformed(problem: SolanaPayProblem): QrClass {
  return { type: "other", reason: "malformed-solana-pay", problem };
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

// The spec allows each of these fields once. A second copy is refused, because
// two wallets reading different copies would show different requests.
const SINGLE_FIELDS = ["amount", "spl-token", "label", "message", "memo"];

// The spec: a non-negative integer or decimal, with a leading 0 before the
// point when below 1, and no scientific notation. Same pattern as the
// reference parseURL.
const AMOUNT = /^\d+(\.\d+)?$/;

interface Query {
  get(name: string): string | null;
  getAll(name: string): string[];
}

/**
 * Reads the query as the spec decodes its fields: split on "&" and on the
 * first "=", then decodeURIComponent, the function SPEC.md links for label,
 * message and memo. Unlike form decoding (URLSearchParams), it keeps a "+" as
 * a "+", so the memo shown is the memo a spec-following wallet writes on chain.
 * The reference parseURL uses URLSearchParams and would read a space. Returns
 * null when a field is not valid percent-encoding.
 */
function readQuery(search: string): Query | null {
  const fields = new Map<string, string[]>();
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    if (part === "") continue;
    const equals = part.indexOf("=");
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(equals === -1 ? part : part.slice(0, equals));
      value = equals === -1 ? "" : decodeURIComponent(part.slice(equals + 1));
    } catch {
      return null;
    }
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return {
    get: (name) => fields.get(name)?.[0] ?? null,
    getAll: (name) => fields.get(name) ?? [],
  };
}

function decimalPlaces(amount: string): number {
  const point = amount.indexOf(".");
  return point === -1 ? 0 : amount.length - point - 1;
}

/**
 * Reads a transfer request's query. Checks run in this order and the first
 * failure is reported: a field that is not valid percent-encoding, a repeated
 * single-value field, the amount, the
 * spl-token, then each reference. A SOL amount with more than 9 decimal
 * places is refused here. An SPL token amount's decimal places are not checked
 * here, because the mint's decimals are not in the URL.
 */
function readTransfer(recipient: string, search: string): QrClass {
  const params = readQuery(search);
  if (params === null) return malformed("query-invalid");
  for (const field of SINGLE_FIELDS) {
    if (params.getAll(field).length > 1) return malformed("duplicate-field");
  }

  const amount = params.get("amount");
  if (amount !== null && !AMOUNT.test(amount)) {
    return malformed("amount-invalid");
  }

  const splToken = params.get("spl-token");
  if (splToken !== null && decodePublicKey(splToken) === null) {
    return malformed("spl-token-invalid");
  }
  if (
    splToken === null &&
    amount !== null &&
    decimalPlaces(amount) > SOL_DECIMALS
  ) {
    return malformed("amount-too-precise");
  }

  // The spec: references are base58-encoded 32-byte arrays.
  const references = params.getAll("reference");
  if (references.some((reference) => decodePublicKey(reference) === null)) {
    return malformed("reference-invalid");
  }

  return {
    type: "solana-pay",
    request: "transfer",
    recipient,
    amount,
    splToken,
    references,
    // As in the reference parseURL, an empty value counts as absent.
    label: params.get("label") || null,
    message: params.get("message") || null,
    memo: params.get("memo") || null,
  };
}

/**
 * Tells a transfer request from a transaction request. The spec puts the
 * recipient public key or the HTTPS link in the pathname. As in the reference
 * parseURL, a pathname that holds ":" or "%" is a link.
 */
function classifySolanaPay(url: URL): QrClass {
  const pathname = url.pathname;
  if (pathname === "") return malformed("no-pathname");

  if (/[:%]/.test(pathname)) {
    // The spec: the wallet must URL-decode the link, and must reject it as
    // malformed when the decoded value is not an absolute HTTPS URL.
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return malformed("link-invalid");
    }
    const link = parseUrl(decoded);
    if (link === null || link.protocol !== "https:") {
      return malformed("link-invalid");
    }
    return { type: "solana-pay", request: "transaction", link: link.href };
  }

  // The spec: the recipient must be a base58-encoded public key.
  if (decodePublicKey(pathname) === null) return malformed("recipient-invalid");
  return readTransfer(pathname, url.search);
}

/**
 * Classifies the text of a scanned QR. A station QR is recognized by its
 * prefix alone; E-05 verifies its signature. Anything that is not a station
 * QR, a well-formed Solana Pay URL or an http or https URL is "other".
 */
export function classifyQr(text: string): QrClass {
  if (text.startsWith(STATION_PREFIX)) return { type: "station", text };

  const url = parseUrl(text);
  if (url === null) return UNRECOGNIZED;

  if (url.protocol === "solana:") {
    if (text.length > MAX_SOLANA_PAY_LENGTH) return malformed("too-long");
    return classifySolanaPay(url);
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { type: "url", href: url.href };
  }
  return UNRECOGNIZED;
}
