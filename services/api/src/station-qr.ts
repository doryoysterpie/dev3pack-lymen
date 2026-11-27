// Signed rotating station QR (E-03).
//
// The text a station QR encodes:
//
//   limen:station:v1.<payload>.<signer>.<signature>
//
//   <payload>    base64url, unpadded, of the UTF-8 JSON object with exactly the keys
//                station, session, nonce, issued_at, expires_at. station and session are
//                IDs of 1 to 64 characters from [A-Za-z0-9_-]. nonce is 16 random bytes in
//                base64url. issued_at and expires_at are Unix times in whole seconds.
//   <signer>     base64url, unpadded, of the signer's 32-byte Ed25519 public key.
//   <signature>  base64url, unpadded, of the 64-byte Ed25519 signature over the ASCII text
//                "limen:station:v1.<payload>", everything before the second dot.
//
// The signature covers the encoded payload text, so changing any character of it, even one
// that decodes to the same bytes, breaks the signature. The station page shows a fresh QR
// every 30 s and each QR lives 60 s, so a participant who scans just before a rotation still
// has 30 s to finish. A QR issued near the end of a session expires when the session ends.
//
// The verifier measures time in milliseconds: a QR is refused at any instant more than 60 s
// after issued_at, or after expires_at, not only from the next whole second.
import {
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export const STATION_QR_PREFIX = "limen:station:";
export const STATION_QR_VERSION = "v1";
/** Longest window a QR may carry, and the oldest a QR may be when verified. */
export const STATION_QR_LIFETIME_S = 60;
/** How often the station page fetches a fresh QR. */
export const STATION_QR_ROTATION_S = 30;
/** How far ahead of the verifier's clock issued_at may be before the QR counts as not yet valid. */
export const STATION_QR_CLOCK_SKEW_S = 5;

const MAX_QR_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const PAYLOAD_KEYS = ["expires_at", "issued_at", "nonce", "session", "station"];
// DER header of an X.509 SubjectPublicKeyInfo Ed25519 public key (RFC 8410).
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface StationPayload {
  readonly station: string;
  readonly session: string;
  readonly nonce: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

export interface StationSigner {
  readonly publicKey: Uint8Array;
  readonly privateKey: KeyObject;
}

export type StationQrRejection =
  | "not_station_qr"
  | "malformed"
  | "unsupported_version"
  | "signer_not_allowlisted"
  | "bad_signature"
  | "invalid_payload"
  | "not_yet_valid"
  | "expired";

export type StationQrResult =
  | {
      readonly ok: true;
      readonly payload: StationPayload;
      readonly signer: string;
    }
  | { readonly ok: false; readonly reason: StationQrRejection };

/** The form a public key takes in a QR and in an allowlist: unpadded base64url of its 32 bytes. */
export function signerId(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("base64url");
}

/** Builds the allowlist a verifier checks the signer against. */
export function stationAllowlist(
  publicKeys: Iterable<Uint8Array>,
): ReadonlySet<string> {
  return new Set([...publicKeys].map(signerId));
}

function signedText(payload: string): string {
  return `${STATION_QR_PREFIX}${STATION_QR_VERSION}.${payload}`;
}

/** Decodes unpadded base64url of an exact byte length, refusing any non-canonical spelling. */
function decodeExact(text: string, length: number): Buffer | null {
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== text)
    return null;
  return bytes;
}

function isUnixSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parsePayload(encoded: string): StationPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some((k, i) => k !== PAYLOAD_KEYS[i])
  ) {
    return null;
  }
  const p = value as Record<string, unknown>;
  if (typeof p.station !== "string" || !ID.test(p.station)) return null;
  if (typeof p.session !== "string" || !ID.test(p.session)) return null;
  if (
    typeof p.nonce !== "string" ||
    !NONCE.test(p.nonce) ||
    !decodeExact(p.nonce, 16)
  ) {
    return null;
  }
  if (!isUnixSeconds(p.issued_at) || !isUnixSeconds(p.expires_at)) return null;
  const window = p.expires_at - p.issued_at;
  if (window <= 0 || window > STATION_QR_LIFETIME_S) return null;
  return {
    station: p.station,
    session: p.session,
    nonce: p.nonce,
    issued_at: p.issued_at,
    expires_at: p.expires_at,
  };
}

/**
 * Issues a station QR for `station` in `session` at Unix time `now` (whole seconds), valid for
 * 60 s or until `notAfter`, whichever comes first. Pass the session's end as `notAfter` so no
 * QR outlives its session.
 */
export function issueStationQr(input: {
  station: string;
  session: string;
  now: number;
  signer: StationSigner;
  nonce?: string;
  notAfter?: number;
}): { text: string; payload: StationPayload } {
  if (!ID.test(input.station))
    throw new Error("station ID must be 1 to 64 characters of [A-Za-z0-9_-]");
  if (!ID.test(input.session))
    throw new Error("session ID must be 1 to 64 characters of [A-Za-z0-9_-]");
  if (!isUnixSeconds(input.now))
    throw new Error("now must be a Unix time in whole seconds");
  const notAfter = input.notAfter ?? input.now + STATION_QR_LIFETIME_S;
  if (!isUnixSeconds(notAfter) || notAfter <= input.now)
    throw new Error("notAfter must be a Unix time in whole seconds after now");
  const nonce = input.nonce ?? randomBytes(16).toString("base64url");
  if (!NONCE.test(nonce) || !decodeExact(nonce, 16))
    throw new Error("nonce must be 16 bytes in base64url");

  const payload: StationPayload = {
    station: input.station,
    session: input.session,
    nonce,
    issued_at: input.now,
    expires_at: Math.min(input.now + STATION_QR_LIFETIME_S, notAfter),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const message = signedText(encoded);
  const signature = sign(
    null,
    Buffer.from(message, "ascii"),
    input.signer.privateKey,
  );
  return {
    text: `${message}.${signerId(input.signer.publicKey)}.${signature.toString("base64url")}`,
    payload,
  };
}

/**
 * Verifies a station QR at Unix time `nowMs`, in milliseconds, against `allowlist`. Checks run in this order and
 * the first failure is the reason: prefix, shape, version, signer encoding, allowlist,
 * signature, payload fields and window, then time.
 */
export function verifyStationQr(
  text: string,
  options: { allowlist: ReadonlySet<string>; nowMs: number },
): StationQrResult {
  const reject = (reason: StationQrRejection): StationQrResult => ({
    ok: false,
    reason,
  });

  if (!text.startsWith(STATION_QR_PREFIX)) return reject("not_station_qr");
  if (text.length > MAX_QR_LENGTH) return reject("malformed");
  const parts = text.slice(STATION_QR_PREFIX.length).split(".");
  if (parts.length !== 4) return reject("malformed");
  const [version, payload, signer, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== STATION_QR_VERSION) return reject("unsupported_version");
  if (!BASE64URL.test(payload)) return reject("malformed");

  const signerBytes = decodeExact(signer, 32);
  if (signerBytes === null) return reject("malformed");
  if (!options.allowlist.has(signer)) return reject("signer_not_allowlisted");

  const signatureBytes = decodeExact(signature, 64);
  if (signatureBytes === null) return reject("malformed");
  let valid: boolean;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, signerBytes]),
      format: "der",
      type: "spki",
    });
    valid = verify(
      null,
      Buffer.from(signedText(payload), "ascii"),
      key,
      signatureBytes,
    );
  } catch {
    valid = false;
  }
  if (!valid) return reject("bad_signature");

  const parsed = parsePayload(payload);
  if (parsed === null) return reject("invalid_payload");
  const issuedMs = parsed.issued_at * 1000;
  if (options.nowMs < issuedMs - STATION_QR_CLOCK_SKEW_S * 1000)
    return reject("not_yet_valid");
  if (
    options.nowMs - issuedMs > STATION_QR_LIFETIME_S * 1000 ||
    options.nowMs > parsed.expires_at * 1000
  ) {
    return reject("expired");
  }
  return { ok: true, payload: parsed, signer };
}
