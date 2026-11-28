// Seeds stations and sessions from a JSON file (E-03), so the station display has a station and
// an active session to sign QRs for. Seeding twice updates names and windows in place.
// Sessions may not overlap: where two did, the API would issue for the later one while QRs from
// the earlier one stayed valid for up to 60 s. Back-to-back sessions, one ending where the next
// starts, do not overlap, since a session's end is exclusive.
// Once a session has started, or starts within 60 s, a seed may change it only by moving its end
// later: QRs issued for it carry expiry times cut to its end, and the API picks a session by its
// window. The check compares each entry with the session as stored before the seed writes
// anything, not with the values the seed would leave (seed.test.ts, the rescheduling probe).
//
//   npm run seed -w @limen/api -- ../../fixtures/demo-event.json
//
// The file holds { "stations": [{ "id", "name" }], "sessions": [{ "id", "name", "starts_at",
// "ends_at" }] }, with times as UTC timestamps of the form 2026-11-26T07:02:00Z.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./db.ts";
import { isMainModule } from "./main-module.ts";

export interface EventSeed {
  readonly stations: readonly { id: string; name: string }[];
  readonly sessions: readonly {
    id: string;
    name: string;
    starts_at: number;
    ends_at: number;
  }[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function fail(where: string, what: string): never {
  throw new Error(`seed ${where}: ${what}`);
}

function field(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): unknown {
  if (!(key in obj)) fail(where, `missing "${key}"`);
  return obj[key];
}

function id(value: unknown, where: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    fail(where, "id must be 1 to 64 characters of [A-Za-z0-9_-]");
  }
  return value;
}

function name(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "")
    fail(where, "name must be a non-empty string");
  return value;
}

function unixSeconds(value: unknown, where: string): number {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) {
    fail(where, "time must look like 2026-11-26T07:02:00Z");
  }
  const ms = Date.parse(value);
  if (
    Number.isNaN(ms) ||
    new Date(ms).toISOString() !== value.replace("Z", ".000Z")
  ) {
    fail(where, `"${value}" is not a real UTC time`);
  }
  return ms / 1000;
}

function records(value: unknown, key: string): Record<string, unknown>[] {
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) fail(key, "must be an array");
  return list.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      fail(`${key}[${i}]`, "must be an object");
    return item as Record<string, unknown>;
  });
}

/** Checks a parsed seed file and returns it with times as Unix seconds. Throws on the first fault. */
export function parseEventSeed(value: unknown): EventSeed {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("file", "must be a JSON object");
  const stations = records(value, "stations").map((s, i) => {
    const where = `stations[${i}]`;
    return {
      id: id(field(s, "id", where), where),
      name: name(field(s, "name", where), where),
    };
  });
  const sessions = records(value, "sessions").map((s, i) => {
    const where = `sessions[${i}]`;
    const starts_at = unixSeconds(field(s, "starts_at", where), where);
    const ends_at = unixSeconds(field(s, "ends_at", where), where);
    if (ends_at <= starts_at) fail(where, "ends_at must be after starts_at");
    return {
      id: id(field(s, "id", where), where),
      name: name(field(s, "name", where), where),
      starts_at,
      ends_at,
    };
  });
  return { stations, sessions };
}

/**
 * Writes the seed into the database in one transaction, and rolls it back if any two sessions in
 * the database would then overlap. Returns how many rows it wrote.
 */
export function seedEvent(
  db: DatabaseSync,
  seed: EventSeed,
  now: number,
): { stations: number; sessions: number } {
  const station = db.prepare(
    "INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name",
  );
  const session = db.prepare(
    "INSERT INTO sessions (id, name, starts_at, ends_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, starts_at = excluded.starts_at, ends_at = excluded.ends_at",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    // Every session as stored, read before this seed writes anything.
    const stored = new Map(
      (
        db
          .prepare("SELECT id, name, starts_at, ends_at FROM sessions")
          .all() as {
          id: string;
          name: string;
          starts_at: number;
          ends_at: number;
        }[]
      ).map((row) => [row.id, row]),
    );
    for (const s of seed.sessions) {
      const was = stored.get(s.id);
      if (
        was !== undefined &&
        was.starts_at < now + 60 &&
        (s.name !== was.name ||
          s.starts_at !== was.starts_at ||
          s.ends_at < was.ends_at)
      )
        fail(
          "sessions",
          `${s.id} has started, or starts within 60 s, so it may only change by ending later`,
        );
    }
    for (const s of seed.stations) station.run(s.id, s.name, now);
    for (const s of seed.sessions)
      session.run(s.id, s.name, s.starts_at, s.ends_at);
    const overlap = db
      .prepare(
        "SELECT a.id AS first, b.id AS second FROM sessions a JOIN sessions b ON a.id < b.id AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at ORDER BY a.id, b.id LIMIT 1",
      )
      .get() as { first: string; second: string } | undefined;
    if (overlap !== undefined)
      fail(
        "sessions",
        `${overlap.first} and ${overlap.second} overlap; sessions may not overlap`,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { stations: seed.stations.length, sessions: seed.sessions.length };
}

/** Why a seed file did not parse, by line and column when the parser gives them, without quoting it. */
export function describeSeedParseFailure(err: unknown): string {
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
      throw new Error("usage: npm run seed -w @limen/api -- <seed file>");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? "unknown error";
      throw new Error(`cannot read seed file ${file} (${reason})`, {
        cause: err,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // No cause attached: the parser's error quotes the file's content.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`seed file ${file} ${describeSeedParseFailure(err)}`);
    }
    const seed = parseEventSeed(parsed);
    const db = openDatabase(process.env.DATABASE_PATH || "limen.db");
    const written = seedEvent(db, seed, Math.floor(Date.now() / 1000));
    console.log(
      `limen seed: wrote stations ${written.stations}, sessions ${written.sessions}`,
    );
  } catch (err) {
    console.error(
      `limen seed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
