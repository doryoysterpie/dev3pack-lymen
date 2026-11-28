// E-07 done test: the same registration ID cannot bind a second wallet.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.ts";
import {
  bindRegistration,
  decodeBase58,
  describeParseFailure,
  importRegistrations,
  isWalletAddress,
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
// Base58 of SHA-256("limen:test-wallet:A") and of "...:B", computed with @solana/web3.js:
// 32-byte values that are not keys anyone holds.
const WALLET_A = "6mmVXu9m4A3FQsggw4qxZzyjkA6GX5XKDK1cMUcmTF14";
const WALLET_B = "Fah9ZWskQePyfjYujnsp1roacZEL2u2QuvU7qgvqXYxW";
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
    "z".repeat(44), // 33 bytes
    "WaLetA" + "1".repeat(38), // 33 bytes
    "1".repeat(31), // 31 bytes
    WALLET_A.slice(0, -1) + "O", // O is not base58
    WALLET_A + "1", // 45 characters
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
      "REGISTRATION_SALT must be set to at least 32 characters (it is not set). To add one to .env without printing it, run from the repository root: { echo; openssl rand -base64 32 | sed 's/^/REGISTRATION_SALT=/'; } >> .env",
  });
  assert.throws(() => loadRegistrationSalt("short-salt-marker"), {
    message:
      "REGISTRATION_SALT must be set to at least 32 characters (it is too short). To add one to .env without printing it, run from the repository root: { echo; openssl rand -base64 32 | sed 's/^/REGISTRATION_SALT=/'; } >> .env",
  });
});

test("a wallet is base58 that decodes to exactly 32 bytes, per an independent decoder", () => {
  // Expected bytes from @solana/web3.js PublicKey.toBytes().
  assert.equal(
    Buffer.from(
      decodeBase58("11111111111111111111111111111111") ?? [],
    ).toString("hex"),
    "00".repeat(32),
  );
  assert.equal(
    Buffer.from(
      decodeBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") ?? [],
    ).toString("hex"),
    "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
  );
  assert.equal(
    Buffer.from(decodeBase58(WALLET_A) ?? []).toString("hex"),
    "55c24c24872557ffd8028d2ab1ccd9b38095d52e048d2987915cb8ba970fd96b",
  );
  const leadingZero = decodeBase58(
    "14jEAGAcW7fYoc6jz4dPgj9bGr3FvUreydWGvg6eMm5Q",
  );
  assert.equal(leadingZero?.length, 32);
  assert.equal(leadingZero?.[0], 0);
  for (const ok of [
    WALLET_A,
    WALLET_B,
    "11111111111111111111111111111111",
    "14jEAGAcW7fYoc6jz4dPgj9bGr3FvUreydWGvg6eMm5Q",
  ]) {
    assert.equal(isWalletAddress(ok), true, ok);
  }
  for (const bad of [
    "z".repeat(44),
    "WaLetA" + "1".repeat(38),
    "1".repeat(31),
    "1".repeat(33),
    "0OIl",
  ]) {
    assert.equal(isWalletAddress(bad), false, bad);
  }
});

test("an ID with non-ASCII letters is refused, not mapped onto an ASCII ID by upper-casing", () => {
  const db = listed();
  importRegistrations(db, SALT, ["LMN-S1", "ST-0001", "STRASSE"]);
  for (const id of [
    "lmn-\u017f1",
    "\ufb06-0001",
    "stra\u00dfe",
    "LMN-\uff10\uff10\uff10\uff11",
  ]) {
    assert.equal(registrationHash(SALT, id), null, id);
    assert.deepEqual(
      bindRegistration(db, SALT, id, WALLET_A, T),
      { ok: false, reason: "invalid_registration_id" },
      id,
    );
    assert.throws(() => importRegistrations(db, SALT, [id]), {
      message:
        "registration 0 is not 1 to 64 characters of [A-Za-z0-9_-] after trimming",
    });
  }
  assert.ok(rows(db).every((r) => r.wallet === null));
});

test("a list file that is not JSON is described by line and column at most, never quoted", () => {
  const inputs = [
    "[LMN-0001, LMN-0002]",
    "LMN-0001\nLMN-0002\nLMN-0003",
    '["LMN-0001",\n "LMN-0002",\n]',
    '["LMN-0001"',
    "",
  ];
  const described = inputs.map((text) => {
    try {
      JSON.parse(text);
    } catch (err) {
      return describeParseFailure(err);
    }
    return "parsed";
  });
  for (const d of described) {
    assert.match(d, /^is not valid JSON( at line \d+, column \d+)?$/);
    assert.ok(!d.includes("LMN"));
  }
  assert.equal(described[3], "is not valid JSON at line 1, column 12");
});

const IMPORT_TOOL = fileURLToPath(
  new URL("./registration.ts", import.meta.url),
);

test("the import tool, run through a symlink, refuses a malformed list without printing its IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-reg-"));
  try {
    const link = join(dir, "import-registrations.ts");
    symlinkSync(IMPORT_TOOL, link);
    const list = join(dir, "list.json");
    writeFileSync(list, "[LMN-0001, LMN-0002]");
    const env = {
      PATH: process.env.PATH ?? "",
      REGISTRATION_SALT: SALT,
      DATABASE_PATH: join(dir, "limen.db"),
    };
    const usage = spawnSync(process.execPath, [link], {
      env,
      encoding: "utf8",
    });
    assert.equal(usage.status, 1);
    assert.equal(
      usage.stderr,
      "limen registrations: usage: npm run import-registrations -w @limen/api -- <file>\n",
    );
    const bad = spawnSync(process.execPath, [link, list], {
      env,
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.equal(
      bad.stderr,
      `limen registrations: registration file ${list} is not valid JSON\n`,
    );
    assert.ok(!bad.stderr.includes("LMN"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
