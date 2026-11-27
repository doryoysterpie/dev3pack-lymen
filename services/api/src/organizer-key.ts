// Organizer key loading (E-02).
//
// Reads the Solana keypair file named by ORGANIZER_KEYPAIR_PATH: the JSON array of 64 byte
// values that solana-keygen writes, the 32-byte Ed25519 seed followed by the 32-byte public
// key. No error message, log line or serialized form produced here carries the file's content
// or the variable's value: a key pasted into the variable by mistake must not reach a terminal.
import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";

// DER header of a PKCS #8 Ed25519 private key (RFC 8410); the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export type OrganizerKeyErrorCode =
  "unset" | "not_a_path" | "unreadable" | "malformed" | "mismatch";

/**
 * A key file problem the operator can act on. The message names the variable and the fault only,
 * never the variable's value or the file's content.
 */
export class OrganizerKeyError extends Error {
  readonly code: OrganizerKeyErrorCode;

  constructor(code: OrganizerKeyErrorCode, message: string) {
    super(message);
    this.name = "OrganizerKeyError";
    this.code = code;
  }
}

/** The loaded organizer key. Printing or serializing it shows the public key only. */
export class OrganizerKey {
  /** The 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** The private key as a node:crypto KeyObject, for signing. */
  readonly privateKey: KeyObject;
  readonly #secretKey: Uint8Array;

  constructor(secretKey: Uint8Array, privateKey: KeyObject) {
    this.#secretKey = Uint8Array.from(secretKey);
    this.publicKey = Uint8Array.from(secretKey.subarray(32));
    this.privateKey = privateKey;
  }

  /** A copy of the 64-byte secret key in Solana's layout, for the Solana SDK. Never log it. */
  secretKeyBytes(): Uint8Array {
    return Uint8Array.from(this.#secretKey);
  }

  toJSON(): { publicKey: string } {
    return { publicKey: Buffer.from(this.publicKey).toString("hex") };
  }

  [inspect.custom](): string {
    return `OrganizerKey { publicKey: ${Buffer.from(this.publicKey).toString("hex")} }`;
  }
}

function parseKeypair(text: string): Uint8Array | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's message quotes the input, so it is dropped, not passed on.
    return null;
  }
  if (!Array.isArray(value) || value.length !== 64) return null;
  if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
    return null;
  return Uint8Array.from(value as number[]);
}

function isByteArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  );
}

/**
 * True when the variable's value is key material rather than a path: it parses as JSON and is
 * an array of byte values, or an object holding one. A path that merely starts with "[" or "{",
 * such as "[dev]/organizer.json", is not.
 */
export function isKeyMaterial(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (isByteArray(parsed)) return true;
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    Object.values(parsed).some(isByteArray)
  );
}

/**
 * Loads the organizer keypair from `path`. Throws OrganizerKeyError when the path is unset, the
 * file cannot be read, its content is not a 64-byte Solana keypair, or its public half does not
 * match the key its secret half derives.
 */
export function loadOrganizerKey(path: string | undefined): OrganizerKey {
  if (path === undefined || path.trim() === "") {
    throw new OrganizerKeyError(
      "unset",
      "ORGANIZER_KEYPAIR_PATH is not set. Point it at the organizer keypair file (see .env.example).",
    );
  }

  if (isKeyMaterial(path)) {
    throw new OrganizerKeyError(
      "not_a_path",
      "ORGANIZER_KEYPAIR_PATH holds what looks like key material, not a file path. Put the keypair in a file outside git and set the variable to that file's path.",
    );
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new OrganizerKeyError(
      "unreadable",
      `The file ORGANIZER_KEYPAIR_PATH names cannot be read (${reason}).`,
    );
  }

  const bytes = parseKeypair(text);
  if (bytes === null) {
    throw new OrganizerKeyError(
      "malformed",
      "The file ORGANIZER_KEYPAIR_PATH names is not a Solana keypair: expected a JSON array of 64 integers from 0 to 255.",
    );
  }

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, bytes.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const derived = Buffer.from(jwk.x ?? "", "base64url");
  const stated = bytes.subarray(32);
  if (derived.length !== 32 || !timingSafeEqual(derived, stated)) {
    throw new OrganizerKeyError(
      "mismatch",
      "The file ORGANIZER_KEYPAIR_PATH names is inconsistent: its public key does not match its secret key.",
    );
  }

  return new OrganizerKey(bytes, privateKey);
}
