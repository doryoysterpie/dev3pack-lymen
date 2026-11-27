// QR payload type detection (E-04). Pure module: it imports the URL parser
// that Expo installs as the global URL on the device, so the Node done test
// runs the same parser the app runs.
//
// Solana Pay rules follow the Solana Pay specification and its reference
// parseURL in solana-foundation/pay at commit 8e1b87c:
// typescript/packages/solana-pay/spec/SPEC.md and
// typescript/packages/solana-pay/core/src/parseURL.ts.

import { URL } from "whatwg-url-minimum";

import { decodePublicKey } from "./base58.ts";

/** Every station QR starts with this text. E-03 defines what follows it. */
export const STATION_PREFIX = "limen:station:";

export type OtherReason = "unrecognized" | "malformed-solana-pay";

export type QrClass =
  | { readonly type: "station"; readonly text: string }
  | {
      readonly type: "solana-pay";
      readonly request: "transfer";
      readonly recipient: string;
    }
  | {
      readonly type: "solana-pay";
      readonly request: "transaction";
      readonly link: string;
    }
  | { readonly type: "url"; readonly href: string }
  | { readonly type: "other"; readonly reason: OtherReason };

const MALFORMED_SOLANA_PAY: QrClass = {
  type: "other",
  reason: "malformed-solana-pay",
};

const UNRECOGNIZED: QrClass = { type: "other", reason: "unrecognized" };

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * Tells a transfer request from a transaction request. The spec puts the
 * recipient public key or the HTTPS link in the pathname. As in the reference
 * parseURL, a pathname that holds ":" or "%" is a link.
 */
function classifySolanaPay(url: URL): QrClass {
  const pathname = url.pathname;
  if (pathname === "") return MALFORMED_SOLANA_PAY;

  if (/[:%]/.test(pathname)) {
    // The spec: the wallet must URL-decode the link, and must reject it as
    // malformed when the decoded value is not an absolute HTTPS URL.
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return MALFORMED_SOLANA_PAY;
    }
    const link = parseUrl(decoded);
    if (link === null || link.protocol !== "https:") {
      return MALFORMED_SOLANA_PAY;
    }
    return { type: "solana-pay", request: "transaction", link: link.href };
  }

  // The spec: the recipient must be a base58-encoded public key.
  if (decodePublicKey(pathname) === null) return MALFORMED_SOLANA_PAY;
  return { type: "solana-pay", request: "transfer", recipient: pathname };
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

  if (url.protocol === "solana:") return classifySolanaPay(url);
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { type: "url", href: url.href };
  }
  return UNRECOGNIZED;
}
