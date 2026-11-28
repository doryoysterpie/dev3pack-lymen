// Station QR verification on the device (E-05, app half). The same rules, in the same order, as
// E-03's verifyStationQr (services/api/src/station-qr.ts), which the backend runs again:
//
//   limen:station:v1.<payload>.<signer>.<signature>
//
// prefix, shape, version, canonical base64url signer, signer on the allowlist, canonical
// signature, Ed25519 over the ASCII text "limen:station:v1.<payload>", exactly the five payload
// fields, a window of at most 60 s, issued no more than 5 s ahead of the device clock, no more
// than 60 s after issued_at and not past expires_at, measured in milliseconds, and a cut-short QR
// (expires_at < issued_at + 60) refused from its expires_at on. Ed25519 itself is passed in, so
// this module stays pure.

import { decodeBase64Url } from "./base64.ts";

export type Ed25519Verify = (
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
) => boolean;

export interface StationPayload {
  readonly station: string;
  readonly session: string;
  readonly nonce: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

export type StationQrRejection =
  | "not_station_qr"
  | "malformed"
  | "unsupported_version"
  | "signer_not_allowlisted"
  | "bad_signature"
  | "invalid_payload"
  | "not_yet_valid"
  | "expired"
  | "invalid_clock";

export type StationQrResult =
  | {
      readonly ok: true;
      readonly payload: StationPayload;
      readonly signer: string;
    }
  | { readonly ok: false; readonly reason: StationQrRejection };

const PREFIX = "limen:station:";
const VERSION = "v1";
const LIFETIME_S = 60;
const CLOCK_SKEW_S = 5;
const MAX_QR_LENGTH = 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAYLOAD_KEYS = ["expires_at", "issued_at", "nonce", "session", "station"];

/** ASCII text to bytes; null if any character is outside ASCII. */
export function asciiBytes(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) return null;
    out[i] = code;
  }
  return out;
}

function asciiText(bytes: Uint8Array): string | null {
  let out = "";
  for (const b of bytes) {
    if (b > 0x7f) return null;
    out += String.fromCharCode(b);
  }
  return out;
}

function isUnixSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parsePayload(encoded: string): StationPayload | null {
  const bytes = decodeBase64Url(encoded);
  const json = bytes === null ? null : asciiText(bytes);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some((k, i) => k !== PAYLOAD_KEYS[i])
  )
    return null;
  const p = value as Record<string, unknown>;
  if (typeof p.station !== "string" || !ID.test(p.station)) return null;
  if (typeof p.session !== "string" || !ID.test(p.session)) return null;
  if (typeof p.nonce !== "string" || decodeBase64Url(p.nonce)?.length !== 16)
    return null;
  if (!isUnixSeconds(p.issued_at) || !isUnixSeconds(p.expires_at)) return null;
  const window = p.expires_at - p.issued_at;
  if (window <= 0 || window > LIFETIME_S) return null;
  return {
    station: p.station,
    session: p.session,
    nonce: p.nonce,
    issued_at: p.issued_at,
    expires_at: p.expires_at,
  };
}

/** Verifies a station QR at Unix time `nowMs`, in milliseconds. The first failing check is the reason. */
export function verifyStationQrOnDevice(
  text: string,
  options: {
    allowlist: ReadonlySet<string>;
    nowMs: number;
    verify: Ed25519Verify;
  },
): StationQrResult {
  const reject = (reason: StationQrRejection): StationQrResult => ({
    ok: false,
    reason,
  });
  // Fail closed, as E-03 does: with no usable clock, no QR can be judged in its window.
  if (!Number.isFinite(options?.nowMs)) return reject("invalid_clock");
  if (!text.startsWith(PREFIX)) return reject("not_station_qr");
  if (text.length > MAX_QR_LENGTH) return reject("malformed");
  const parts = text.slice(PREFIX.length).split(".");
  if (parts.length !== 4) return reject("malformed");
  const [version, payload, signer, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) return reject("unsupported_version");
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return reject("malformed");

  const signerBytes = decodeBase64Url(signer);
  if (signerBytes === null || signerBytes.length !== 32)
    return reject("malformed");
  if (!options.allowlist.has(signer)) return reject("signer_not_allowlisted");
  const signatureBytes = decodeBase64Url(signature);
  if (signatureBytes === null || signatureBytes.length !== 64)
    return reject("malformed");

  const signed = asciiBytes(`${PREFIX}${VERSION}.${payload}`);
  let valid: boolean;
  try {
    valid =
      signed !== null && options.verify(signerBytes, signed, signatureBytes);
  } catch {
    valid = false;
  }
  if (!valid) return reject("bad_signature");

  const parsed = parsePayload(payload);
  if (parsed === null) return reject("invalid_payload");
  const issuedMs = parsed.issued_at * 1000;
  if (options.nowMs < issuedMs - CLOCK_SKEW_S * 1000)
    return reject("not_yet_valid");
  // As E-03's verifyStationQr: a full-length QR is accepted up to and including 60,000 ms after
  // issue. A cut-short QR (expires_at < issued_at + 60) is refused from its expires_at on, since
  // E-03 cuts short every QR whose 60 s would reach its session's end, to that end or earlier.
  const cutShort = parsed.expires_at < parsed.issued_at + LIFETIME_S;
  const expiresMs = parsed.expires_at * 1000;
  if (
    options.nowMs - issuedMs > LIFETIME_S * 1000 ||
    options.nowMs > expiresMs ||
    (cutShort && options.nowMs >= expiresMs)
  ) {
    return reject("expired");
  }
  return { ok: true, payload: parsed, signer };
}
