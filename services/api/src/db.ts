// SQLite schema and migrations for the limen API (E-02).
//
// Migrations are append-only. A later unit adds a new entry to MIGRATIONS and never edits a
// shipped one. PRAGMA user_version records how many migrations the database has applied.
// Every *_at column holds Unix time in whole seconds.
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE stations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    CHECK (ends_at > starts_at)
  ) STRICT;

  CREATE TABLE registrations (
    reg_hash TEXT PRIMARY KEY,
    wallet TEXT UNIQUE,
    bound_at INTEGER,
    CHECK ((wallet IS NULL) = (bound_at IS NULL))
  ) STRICT;

  CREATE TABLE checkins (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    station_id TEXT NOT NULL REFERENCES stations (id),
    reg_hash TEXT NOT NULL REFERENCES registrations (reg_hash),
    wallet TEXT NOT NULL,
    station_nonce TEXT NOT NULL,
    mint TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, reg_hash)
  ) STRICT;

  CREATE TABLE cases (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('held', 'escalated')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sightings (
    id INTEGER PRIMARY KEY,
    case_id INTEGER REFERENCES cases (id),
    device_hash TEXT NOT NULL,
    qr_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  `,
  // E-10: the evidence bundle behind each sighting. The sighting row holds the QR payload
  // (qr_text) and the reporting device's hash; this row holds the rest of the bundle. JSON
  // columns hold canonical JSON (object keys sorted, address lists sorted and deduplicated).
  // wallet stays NULL unless the reporter opted in. resimulation_matches records whether the
  // stored transaction bytes re-simulated to the stored summary; drain_pattern records whether
  // that re-simulated summary shows a drain pattern. Both stay NULL until a re-simulation runs.
  // resimulation_failed_at records the last time a re-simulation was tried and failed.
  `
  CREATE TABLE evidence_bundles (
    sighting_id INTEGER PRIMARY KEY REFERENCES sightings (id),
    url TEXT,
    transaction_b64 TEXT,
    simulation_slot INTEGER,
    simulation_blockhash TEXT,
    summary_json TEXT NOT NULL,
    program_ids_json TEXT NOT NULL,
    recipients_json TEXT NOT NULL,
    reported_at INTEGER NOT NULL,
    app_version TEXT NOT NULL,
    wallet TEXT,
    resimulated_at INTEGER,
    resimulation_matches INTEGER CHECK (resimulation_matches IN (0, 1)),
    drain_pattern INTEGER CHECK (drain_pattern IN (0, 1)),
    resimulation_failed_at INTEGER,
    CHECK ((simulation_slot IS NULL) = (simulation_blockhash IS NULL)),
    CHECK ((transaction_b64 IS NULL) <= (simulation_slot IS NULL)),
    CHECK ((resimulated_at IS NULL) = (resimulation_matches IS NULL)),
    CHECK ((resimulated_at IS NULL) = (drain_pattern IS NULL)),
    CHECK (transaction_b64 IS NOT NULL OR resimulated_at IS NULL),
    CHECK (transaction_b64 IS NOT NULL OR resimulation_failed_at IS NULL)
  ) STRICT;
  `,
];

/** The number of migrations the database has applied, read from PRAGMA user_version. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

/**
 * Applies every migration the database has not applied yet, each in its own transaction.
 * Returns the resulting schema version. Refuses a database whose version is newer than this
 * build knows, rather than running against a schema it cannot describe.
 */
export function migrate(db: DatabaseSync): number {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${current} is newer than this build supports (${MIGRATIONS.length})`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return schemaVersion(db);
}

/** Opens the database at `path` (":memory:" for a throwaway one), with foreign keys on, and migrates it. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
