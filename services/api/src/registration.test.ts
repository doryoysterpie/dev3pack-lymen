// E-07 done test: the same registration ID cannot bind a second wallet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openDatabase } from "./db.ts";
import {
  bindRegistration,
  importRegistrations,
  loadRegistrationSalt,
  registrationForWallet,
  registrationHash,
} from "./registration.ts";

const SALT = "test-salt-0123456789abcdef0123456789";
const MOCK_LIST = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/registrations.json", import.meta.url),
    "utf8",
  ),
) as string[];
// Synthetic base58 strings shaped like Solana addresses. Not real keys.
const WALLET_A = "WaLetA" + "1".repeat(38);
const WALLET_B = "WaLetB" + "1".repeat(38);
const T = 1_795_000_000;

function listed(): DatabaseSync {
  const db = openDatabase(":memory:");
  importRegistrations(db, SALT, MOCK_LIST);
  return db;
}

function rows(
  db: DatabaseSync,
): { reg_hash: string; wallet: string | null; bound_at: number | null }[] {
  return db
    .prepare(
      "SELECT reg_hash, wallet, bound_at FROM registrations ORDER BY reg_hash",
    )
    .all()
    .map((r) => ({ ...r })) as {
    reg_hash: string;
    wallet: string | null;
    bound_at: number | null;
  }[];
}

test("the registration hash is HMAC-SHA256 keyed by the salt, as an independent HMAC computes it", () => {
  // Expected values from Python's hmac module: hmac.new(salt, b"LMN-0001", hashlib.sha256).
  assert.equal(
    registrationHash(SALT, "LMN-0001"),
    "dbc61dac57d558cdabbb78597d62c7fca5df89f595b9973d5826f4e594ab92cb",
  );
  assert.equal(
    registrationHash("other-salt-0123456789abcdef012345678", "LMN-0001"),
    "1d6b9a6fe58c0a61697adcdb180ce3aa09cc66e5e46b87df245e104da3d1d78e",
  );
  assert.equal(
    registrationHash(SALT, "  lmn-0001 "),
    registrationHash(SALT, "LMN-0001"),
  );
  assert.equal(registrationHash(SALT, "LMN 0001"), null);
  assert.equal(registrationHash(SALT, ""), null);
});

test("importing the mock list stores ten unbound hashes and no plain registration ID", () => {
  const db = listed();
  const stored = rows(db);
  assert.equal(stored.length, 10);
  assert.ok(stored.every((r) => r.wallet === null && r.bound_at === null));
  const expected = MOCK_LIST.map((id) => registrationHash(SALT, id)).sort();
  assert.deepEqual(
    stored.map((r) => r.reg_hash),
    expected,
  );
  const everything = JSON.stringify(
    db.prepare("SELECT * FROM registrations").all(),
  );
  for (const id of MOCK_LIST)
    assert.ok(!everything.includes(id), `${id} stored in plain`);
  assert.deepEqual(importRegistrations(db, SALT, MOCK_LIST), {
    added: 0,
    alreadyListed: 10,
  });
});

test("done test: the same registration ID cannot bind a second wallet", () => {
  const db = listed();
  const first = bindRegistration(db, SALT, "LMN-0001", WALLET_A, T);
  assert.deepEqual(first, {
    ok: true,
    regHash: registrationHash(SALT, "LMN-0001"),
    firstBinding: true,
  });

  const second = bindRegistration(db, SALT, "LMN-0001", WALLET_B, T + 10);
  assert.deepEqual(second, {
    ok: false,
    reason: "registration_bound_to_other_wallet",
  });
  // The same ID spelled differently is the same registration, and is refused the same way.
  assert.deepEqual(bindRegistration(db, SALT, " lmn-0001 ", WALLET_B, T + 20), {
    ok: false,
    reason: "registration_bound_to_other_wallet",
  });

  // Nothing changed: the registration still holds wallet A from time T, and B has no binding.
  const row = rows(db).find(
    (r) => r.reg_hash === registrationHash(SALT, "LMN-0001"),
  );
  assert.deepEqual(row, {
    reg_hash: registrationHash(SALT, "LMN-0001"),
    wallet: WALLET_A,
    bound_at: T,
  });
  assert.equal(registrationForWallet(db, WALLET_B), null);
  assert.equal(
    registrationForWallet(db, WALLET_A),
    registrationHash(SALT, "LMN-0001"),
  );
});

test("binding the same pair again succeeds without changing the first binding time", () => {
  const db = listed();
  bindRegistration(db, SALT, "LMN-0002", WALLET_A, T);
  assert.deepEqual(bindRegistration(db, SALT, "LMN-0002", WALLET_A, T + 99), {
    ok: true,
    regHash: registrationHash(SALT, "LMN-0002"),
    firstBinding: false,
  });
  const row = rows(db).find((r) => r.wallet === WALLET_A);
  assert.equal(row?.bound_at, T);
});

test("a wallet bound to one registration cannot bind a second", () => {
  const db = listed();
  bindRegistration(db, SALT, "LMN-0003", WALLET_A, T);
  assert.deepEqual(bindRegistration(db, SALT, "LMN-0004", WALLET_A, T), {
    ok: false,
    reason: "wallet_bound_to_other_registration",
  });
  const row = rows(db).find(
    (r) => r.reg_hash === registrationHash(SALT, "LMN-0004"),
  );
  assert.equal(row?.wallet, null);
});

test("an ID not on the list, a malformed ID and a malformed wallet are refused with the owed reason", () => {
  const db = listed();
  assert.deepEqual(bindRegistration(db, SALT, "LMN-9999", WALLET_A, T), {
    ok: false,
    reason: "unknown_registration",
  });
  assert.deepEqual(bindRegistration(db, SALT, "LMN 0001", WALLET_A, T), {
    ok: false,
    reason: "invalid_registration_id",
  });
  for (const wallet of [
    "",
    "0".repeat(44),
    "WaLetA" + "1".repeat(39),
    "WaLetA1",
    "WaLetO" + "1".repeat(38),
  ]) {
    assert.deepEqual(bindRegistration(db, SALT, "LMN-0001", wallet, T), {
      ok: false,
      reason: "invalid_wallet",
    });
  }
  // A list hashed with another salt does not match: the salt is part of the binding.
  assert.deepEqual(
    bindRegistration(
      db,
      "other-salt-0123456789abcdef012345678",
      "LMN-0001",
      WALLET_A,
      T,
    ),
    {
      ok: false,
      reason: "unknown_registration",
    },
  );
  assert.ok(rows(db).every((r) => r.wallet === null));
});

test("REGISTRATION_SALT must be set to at least 32 characters, and the error never echoes it", () => {
  assert.equal(loadRegistrationSalt(SALT), SALT);
  assert.throws(() => loadRegistrationSalt(undefined), {
    message:
      "REGISTRATION_SALT must be set to at least 32 characters (it is not set). Generate one with: openssl rand -base64 32",
  });
  assert.throws(() => loadRegistrationSalt("short-salt-marker"), {
    message:
      "REGISTRATION_SALT must be set to at least 32 characters (it is too short). Generate one with: openssl rand -base64 32",
  });
});
