// E-02 done test, part 1: the schema migrates from empty. E-10 adds migration 2.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { MIGRATIONS, migrate, openDatabase, schemaVersion } from "./db.ts";

// The schema owed after every migration: E-02's six tables and E-10's evidence_bundles, with
// their columns in declaration order.
const OWED_SCHEMA: Record<string, string[]> = {
  cases: ["id", "status", "created_at", "updated_at"],
  checkins: [
    "id",
    "session_id",
    "station_id",
    "reg_hash",
    "wallet",
    "station_nonce",
    "mint",
    "created_at",
  ],
  evidence_bundles: [
    "sighting_id",
    "url",
    "transaction_b64",
    "simulation_slot",
    "simulation_blockhash",
    "summary_json",
    "program_ids_json",
    "recipients_json",
    "reported_at",
    "app_version",
    "wallet",
    "resimulated_at",
    "resimulation_matches",
    "drain_pattern",
    "resimulation_failed_at",
  ],
  registrations: ["reg_hash", "wallet", "bound_at"],
  sessions: ["id", "name", "starts_at", "ends_at"],
  sightings: ["id", "case_id", "device_hash", "qr_text", "created_at"],
  stations: ["id", "name", "created_at"],
};

function tables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "limen-db-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an empty database migrates to schema version 2 with exactly the seven owed tables", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(schemaVersion(db), 0);
  assert.deepEqual(tables(db), []);

  assert.equal(migrate(db), 2);
  assert.equal(schemaVersion(db), 2);
  assert.equal(MIGRATIONS.length, 2);
  assert.deepEqual(tables(db), Object.keys(OWED_SCHEMA).sort());
  for (const [table, owed] of Object.entries(OWED_SCHEMA)) {
    assert.deepEqual(columns(db, table), owed, `columns of ${table}`);
  }
});

test("an empty database file on disk migrates, and reopening it does not migrate again", () => {
  withTempDir((dir) => {
    const path = join(dir, "limen.db");
    const first = openDatabase(path);
    assert.equal(schemaVersion(first), 2);
    first
      .prepare("INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?)")
      .run("st-1", "Front desk", 1_700_000_000);
    first.close();

    const second = openDatabase(path);
    assert.equal(schemaVersion(second), 2);
    const row = second
      .prepare("SELECT name FROM stations WHERE id = ?")
      .get("st-1") as {
      name: string;
    };
    assert.equal(row.name, "Front desk");
    second.close();
  });
});

test("a database from a newer build is refused, not run against", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 99");
  assert.throws(
    () => migrate(db),
    /schema version 99 is newer than this build supports \(2\)/,
  );
});

test("the schema refuses a second check-in for the same registration in the same session", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-1', 'Front desk', 1);
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('s-1', 'Day 1', 1, 2);
    INSERT INTO registrations (reg_hash, wallet, bound_at) VALUES ('h-1', 'w-1', 1);
  `);
  const insert = db.prepare(
    "INSERT INTO checkins (session_id, station_id, reg_hash, wallet, station_nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run("s-1", "st-1", "h-1", "w-1", "n-1", 1);
  assert.throws(
    () => insert.run("s-1", "st-1", "h-1", "w-1", "n-2", 2),
    /UNIQUE constraint failed: checkins.session_id, checkins.reg_hash/,
  );
});

test("the schema enforces foreign keys and a wallet bound to at most one registration", () => {
  const db = openDatabase(":memory:");
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO checkins (session_id, station_id, reg_hash, wallet, station_nonce, created_at) VALUES ('none', 'none', 'none', 'w', 'n', 1)",
      ),
    /FOREIGN KEY constraint failed/,
  );
  db.exec(
    "INSERT INTO registrations (reg_hash, wallet, bound_at) VALUES ('h-1', 'w-1', 1)",
  );
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO registrations (reg_hash, wallet, bound_at) VALUES ('h-2', 'w-1', 2)",
      ),
    /UNIQUE constraint failed: registrations.wallet/,
  );
});

test("a version 1 database migrates to version 2 and keeps its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  db.exec(MIGRATIONS[0]);
  db.exec("PRAGMA user_version = 1");
  db.exec("COMMIT");
  db.exec(
    "INSERT INTO sightings (device_hash, qr_text, created_at) VALUES ('d-1', 'qr', 1)",
  );
  assert.equal(migrate(db), 2);
  const row = db.prepare("SELECT qr_text FROM sightings").get() as {
    qr_text: string;
  };
  assert.equal(row.qr_text, "qr");
});

test("an evidence bundle cannot record a simulation or a re-simulation without transaction bytes", () => {
  const db = openDatabase(":memory:");
  db.exec(
    "INSERT INTO sightings (id, device_hash, qr_text, created_at) VALUES (1, 'd-1', 'qr', 1)",
  );
  const insert = db.prepare(
    `INSERT INTO evidence_bundles (sighting_id, transaction_b64, simulation_slot, simulation_blockhash,
       summary_json, program_ids_json, recipients_json, reported_at, app_version,
       resimulated_at, resimulation_matches, drain_pattern)
     VALUES (1, ?, ?, ?, '{}', '[]', '[]', 1, '0.1.0', ?, ?, ?)`,
  );
  assert.throws(
    () => insert.run(null, 5, "bh", null, null, null),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run(null, null, null, 2, 1, 0),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run("AA==", 5, "bh", 2, 1, null),
    /CHECK constraint failed/,
  );
  insert.run("AA==", 5, "bh", 2, 1, 0);
});

test("an evidence bundle cannot record a failed re-simulation without transaction bytes", () => {
  const db = openDatabase(":memory:");
  db.exec(
    "INSERT INTO sightings (id, device_hash, qr_text, created_at) VALUES (1, 'd-1', 'qr', 1), (2, 'd-2', 'qr', 1)",
  );
  const insert = db.prepare(
    `INSERT INTO evidence_bundles (sighting_id, transaction_b64, summary_json, program_ids_json,
       recipients_json, reported_at, app_version, resimulation_failed_at)
     VALUES (?, ?, '{}', '[]', '[]', 1, '0.1.0', 3)`,
  );
  assert.throws(() => insert.run(1, null), /CHECK constraint failed/);
  insert.run(2, "AA==");
});
