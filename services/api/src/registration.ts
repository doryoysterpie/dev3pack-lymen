// Registration binding (E-07).
//
// The organizer's registration list is imported as salted hashes only: HMAC-SHA256 keyed by
// REGISTRATION_SALT over the registration ID, trimmed, checked to be ASCII letters, digits, "_"
// and "-", then upper-cased. The database never holds
// a plain registration ID. At a participant's first check-in, E-05 binds the hash to the
// participant's wallet. A registration binds one wallet, and a wallet binds one registration.
//
//   npm run import-registrations -w @limen/api -- ../../fixtures/registrations.json
//
// imports a JSON array of registration IDs, such as the mock list in fixtures/.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./db.ts";
import { isMainModule } from "./main-module.ts";

const MIN_SALT_LENGTH = 32;
// Checked before upper-casing, so Unicode case rules can never map other letters onto it.
const REGISTRATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes base58 (the Bitcoin alphabet Solana uses), or returns null for any other character. */
export function decodeBase58(text: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]*$/.test(text)) return null;
  let value = 0n;
  for (const c of text)
    value = value * 58n + BigInt(BASE58_ALPHABET.indexOf(c));
  const bytes: number[] = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/** A Solana address: base58 that decodes to exactly 32 bytes. */
export function isWalletAddress(text: string): boolean {
  return text.length <= 44 && decodeBase58(text)?.length === 32;
}

export type BindingRefusal =
  | "invalid_registration_id"
  | "invalid_wallet"
  | "unknown_registration"
  | "registration_bound_to_other_wallet"
  | "wallet_bound_to_other_registration";

export type BindingResult =
  | {
      readonly ok: true;
      readonly regHash: string;
      readonly firstBinding: boolean;
    }
  | { readonly ok: false; readonly reason: BindingRefusal };

/** Reads REGISTRATION_SALT. The error says whether it is unset or short, never what it holds. */
export function loadRegistrationSalt(value: string | undefined): string {
  if (value === undefined || value.length < MIN_SALT_LENGTH) {
    throw new Error(
      `REGISTRATION_SALT must be set to at least ${MIN_SALT_LENGTH} characters (${value === undefined || value === "" ? "it is not set" : "it is too short"}). Generate one with: openssl rand -base64 32`,
    );
  }
  return value;
}

/**
 * The registration ID as compared: surrounding space removed, then, only if what is left is 1 to
 * 64 ASCII letters, digits, "_" or "-", upper-cased. Anything else is refused, not mapped.
 */
export function normalizeRegistrationId(registrationId: string): string | null {
  const id = registrationId.trim();
  return REGISTRATION_ID.test(id) ? id.toUpperCase() : null;
}

/** HMAC-SHA256 of the normalized registration ID, keyed by the salt, in hex. */
export function registrationHash(
  salt: string,
  registrationId: string,
): string | null {
  const id = normalizeRegistrationId(registrationId);
  if (id === null) return null;
  return createHmac("sha256", salt).update(id, "utf8").digest("hex");
}

/** Adds each registration ID's hash to the list. IDs already listed are left as they are. */
export function importRegistrations(
  db: DatabaseSync,
  salt: string,
  registrationIds: readonly string[],
): { added: number; alreadyListed: number } {
  const hashes = registrationIds.map((raw, i) => {
    const hash = registrationHash(salt, raw);
    if (hash === null) {
      throw new Error(
        `registration ${i} is not 1 to 64 characters of [A-Za-z0-9_-] after trimming`,
      );
    }
    return hash;
  });
  const insert = db.prepare(
    "INSERT INTO registrations (reg_hash) VALUES (?) ON CONFLICT DO NOTHING",
  );
  let added = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const hash of hashes) added += Number(insert.run(hash).changes);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { added, alreadyListed: hashes.length - added };
}

/**
 * Binds a registration to a wallet at its first check-in. Binding the same pair again succeeds
 * with firstBinding false. A registration already bound to another wallet, or a wallet already
 * bound to another registration, is refused and nothing changes.
 */
export function bindRegistration(
  db: DatabaseSync,
  salt: string,
  registrationId: string,
  wallet: string,
  now: number,
): BindingResult {
  const regHash = registrationHash(salt, registrationId);
  if (regHash === null) return { ok: false, reason: "invalid_registration_id" };
  if (!isWalletAddress(wallet)) return { ok: false, reason: "invalid_wallet" };

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = bindInTransaction(db, regHash, wallet, now);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function bindInTransaction(
  db: DatabaseSync,
  regHash: string,
  wallet: string,
  now: number,
): BindingResult {
  const row = db
    .prepare("SELECT wallet FROM registrations WHERE reg_hash = ?")
    .get(regHash) as { wallet: string | null } | undefined;
  if (row === undefined) return { ok: false, reason: "unknown_registration" };
  if (row.wallet === wallet) return { ok: true, regHash, firstBinding: false };
  if (row.wallet !== null)
    return { ok: false, reason: "registration_bound_to_other_wallet" };

  const other = db
    .prepare("SELECT reg_hash FROM registrations WHERE wallet = ?")
    .get(wallet);
  if (other !== undefined)
    return { ok: false, reason: "wallet_bound_to_other_registration" };

  const changed = db
    .prepare(
      "UPDATE registrations SET wallet = ?, bound_at = ? WHERE reg_hash = ? AND wallet IS NULL",
    )
    .run(wallet, now, regHash).changes;
  if (Number(changed) !== 1)
    throw new Error(
      "registration binding changed no row inside its transaction",
    );
  return { ok: true, regHash, firstBinding: true };
}

/** The registration hash a wallet is bound to, or null when the wallet has no binding. */
export function registrationForWallet(
  db: DatabaseSync,
  wallet: string,
): string | null {
  const row = db
    .prepare("SELECT reg_hash FROM registrations WHERE wallet = ?")
    .get(wallet) as { reg_hash: string } | undefined;
  return row?.reg_hash ?? null;
}

/**
 * Why a list file did not parse, without quoting it: the parser's own message repeats part of
 * the file, which holds plain registration IDs, so only its line and column are kept.
 */
export function describeParseFailure(err: unknown): string {
  const at = /\(line (\d+) column (\d+)\)/.exec(
    err instanceof Error ? err.message : "",
  );
  return at
    ? `is not valid JSON at line ${at[1]}, column ${at[2]}`
    : "is not valid JSON";
}

if (isMainModule(import.meta.url)) {
  try {
    const file = process.argv[2];
    if (file === undefined)
      throw new Error(
        "usage: npm run import-registrations -w @limen/api -- <file>",
      );
    const salt = loadRegistrationSalt(process.env.REGISTRATION_SALT);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? "unknown error";
      throw new Error(`cannot read registration file ${file} (${reason})`, {
        cause: err,
      });
    }
    let ids: unknown;
    try {
      ids = JSON.parse(text);
    } catch (err) {
      // No cause attached: the parser's error quotes the file's registration IDs.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`registration file ${file} ${describeParseFailure(err)}`);
    }
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      throw new Error(
        `registration file ${file} must be a JSON array of strings`,
      );
    }
    const db = openDatabase(process.env.DATABASE_PATH || "limen.db");
    const { added, alreadyListed } = importRegistrations(db, salt, ids);
    console.log(
      `limen registrations: added ${added}, already listed ${alreadyListed}`,
    );
  } catch (err) {
    console.error(
      `limen registrations: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
