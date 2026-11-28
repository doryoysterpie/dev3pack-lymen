// E-03 support: the demo seed gives the station display a station and an active session.
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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.ts";
import { parseEventSeed, seedEvent } from "./seed.ts";

const DEMO = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/demo-event.json", import.meta.url),
    "utf8",
  ),
) as unknown;

/** A clock that reads `seconds`, as seedEvent takes one. */
const at = (seconds: number) => (): number => seconds;

test("the demo seed writes the front desk station and the build window session in Unix seconds", () => {
  const db = openDatabase(":memory:");
  assert.deepEqual(seedEvent(db, parseEventSeed(DEMO), at(1_795_700_000)), {
    stations: 1,
    sessions: 1,
  });
  assert.deepEqual(
    db
      .prepare("SELECT id, name, created_at FROM stations")
      .all()
      .map((r) => ({ ...r })),
    [{ id: "st-front", name: "Front desk", created_at: 1_795_700_000 }],
  );
  // 2026-11-26T07:02:00Z and 2027-01-01T00:00:00Z.
  assert.deepEqual(
    db
      .prepare("SELECT id, name, starts_at, ends_at FROM sessions")
      .all()
      .map((r) => ({ ...r })),
    [
      {
        id: "build-window",
        name: "Build window",
        starts_at: 1_795_676_520,
        ends_at: 1_798_761_600,
      },
    ],
  );
});

test("seeding twice updates in place and adds no rows", () => {
  const db = openDatabase(":memory:");
  const seed = parseEventSeed(DEMO);
  seedEvent(db, seed, at(1));
  seedEvent(
    db,
    { ...seed, stations: [{ id: "st-front", name: "Main desk" }] },
    at(2),
  );
  assert.deepEqual(
    db
      .prepare("SELECT id, name, created_at FROM stations")
      .all()
      .map((r) => ({ ...r })),
    [{ id: "st-front", name: "Main desk", created_at: 1 }],
  );
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n,
    1,
  );
});

const session = (id: string, starts_at: number, ends_at: number) => ({
  id,
  name: id,
  starts_at,
  ends_at,
});
const sessionRows = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare("SELECT id, starts_at, ends_at FROM sessions ORDER BY id")
    .all()
    .map((r) => ({ ...r }));

test("sessions may not overlap: a seed whose sessions overlap is refused, and nothing is written", () => {
  const db = openDatabase(":memory:");
  assert.throws(
    () =>
      seedEvent(
        db,
        {
          stations: [{ id: "st-front", name: "Front desk" }],
          sessions: [
            session("day-1", 1000, 2000),
            session("day-2", 1999, 3000),
          ],
        },
        at(1),
      ),
    {
      message:
        "seed sessions: day-1 and day-2 overlap; sessions may not overlap",
    },
  );
  assert.deepEqual(sessionRows(db), []);
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM stations").get() as { n: number }).n,
    0,
  );
});

test("a seed whose session overlaps one already in the database is refused, and the database keeps its rows", () => {
  const db = openDatabase(":memory:");
  seedEvent(
    db,
    { stations: [], sessions: [session("day-1", 1000, 2000)] },
    at(1),
  );
  assert.throws(
    () =>
      seedEvent(
        db,
        { stations: [], sessions: [session("day-2", 1500, 2500)] },
        at(2),
      ),
    {
      message:
        "seed sessions: day-1 and day-2 overlap; sessions may not overlap",
    },
  );
  assert.deepEqual(sessionRows(db), [
    { id: "day-1", starts_at: 1000, ends_at: 2000 },
  ]);
  // Moving a session onto another's window is refused the same way.
  seedEvent(
    db,
    { stations: [], sessions: [session("day-2", 2000, 3000)] },
    at(3),
  );
  assert.throws(
    () =>
      seedEvent(
        db,
        { stations: [], sessions: [session("day-2", 1999, 3000)] },
        at(4),
      ),
    /day-1 and day-2 overlap/,
  );
});

test("once a session has started, or starts within 60 s, a seed may change it only by moving its end later", () => {
  const db = openDatabase(":memory:");
  seedEvent(
    db,
    { stations: [], sessions: [session("day-1", 1000, 2000)] },
    at(1),
  );
  const refused = (change: ReturnType<typeof session>, now: number) =>
    assert.throws(
      () => seedEvent(db, { stations: [], sessions: [change] }, at(now)),
      {
        message:
          "seed sessions: day-1 has started, or starts within 60 s, so it may only change by ending later",
      },
    );
  // At 1500 day-1 has started.
  refused(session("day-1", 1000, 1800), 1500); // an earlier end
  refused(session("day-1", 1100, 2000), 1500); // a moved start
  refused({ ...session("day-1", 1000, 2000), name: "Day one" }, 1500); // a new name
  assert.deepEqual(sessionRows(db), [
    { id: "day-1", starts_at: 1000, ends_at: 2000 },
  ]);
  // The same row again changes nothing, and a later end is allowed.
  seedEvent(
    db,
    { stations: [], sessions: [session("day-1", 1000, 2000)] },
    at(1500),
  );
  seedEvent(
    db,
    { stations: [], sessions: [session("day-1", 1000, 2500)] },
    at(1500),
  );
  assert.deepEqual(sessionRows(db), [
    { id: "day-1", starts_at: 1000, ends_at: 2500 },
  ]);
  // 59 s and exactly 60 s before it starts the session is fixed; 61 s before, it may still change.
  refused(session("day-1", 1000, 1900), 941);
  refused(session("day-1", 1000, 1900), 940);
  seedEvent(
    db,
    { stations: [], sessions: [session("day-1", 1100, 1900)] },
    at(939),
  );
  assert.deepEqual(sessionRows(db), [
    { id: "day-1", starts_at: 1100, ends_at: 1900 },
  ]);
});

test("the rescheduling probe: moving a live session's start later while adding a session over its old window is refused", () => {
  const T0 = 10_000;
  const db = openDatabase(":memory:");
  seedEvent(
    db,
    { stations: [], sessions: [session("s1", T0 - 100, T0 + 600)] },
    at(T0 - 200),
  );
  // At T0, s1 is live. The guard reads s1 as stored, not as the seed would leave it.
  assert.throws(
    () =>
      seedEvent(
        db,
        {
          stations: [],
          sessions: [
            session("s1", T0 + 300, T0 + 600),
            session("s2", T0 - 50, T0 + 200),
          ],
        },
        at(T0),
      ),
    /s1 has started, or starts within 60 s, so it may only change by ending later/,
  );
  // Listing s1 twice does not help: each entry is checked against the stored row.
  assert.throws(
    () =>
      seedEvent(
        db,
        {
          stations: [],
          sessions: [
            session("s1", T0 - 100, T0 + 600),
            session("s1", T0 + 300, T0 + 600),
          ],
        },
        at(T0),
      ),
    /s1 has started, or starts within 60 s, so it may only change by ending later/,
  );
  assert.deepEqual(sessionRows(db), [
    { id: "s1", starts_at: T0 - 100, ends_at: T0 + 600 },
  ]);
});

test("back-to-back sessions do not overlap, since a session's end is exclusive", () => {
  const db = openDatabase(":memory:");
  seedEvent(
    db,
    {
      stations: [],
      sessions: [session("day-1", 1000, 2000), session("day-2", 2000, 3000)],
    },
    at(1),
  );
  assert.deepEqual(sessionRows(db), [
    { id: "day-1", starts_at: 1000, ends_at: 2000 },
    { id: "day-2", starts_at: 2000, ends_at: 3000 },
  ]);
});

test("a seed with a bad field is refused with a message naming the field", () => {
  const good = {
    id: "s",
    name: "S",
    starts_at: "2026-11-26T07:02:00Z",
    ends_at: "2026-11-27T07:02:00Z",
  };
  const cases: [unknown, RegExp][] = [
    [[], /^seed file: must be a JSON object$/],
    [{ sessions: [] }, /^seed stations: must be an array$/],
    [
      { stations: [{ id: "a b", name: "x" }], sessions: [] },
      /^seed stations\[0\]: id must be/,
    ],
    [
      { stations: [{ id: "a" }], sessions: [] },
      /^seed stations\[0\]: missing "name"$/,
    ],
    [
      { stations: [], sessions: [{ ...good, starts_at: "2026-11-26 07:02" }] },
      /^seed sessions\[0\]: time must look like/,
    ],
    [
      {
        stations: [],
        sessions: [{ ...good, starts_at: "2026-02-30T00:00:00Z" }],
      },
      /is not a real UTC time$/,
    ],
    [
      { stations: [], sessions: [{ ...good, ends_at: good.starts_at }] },
      /^seed sessions\[0\]: ends_at must be after starts_at$/,
    ],
  ];
  for (const [value, message] of cases) {
    assert.throws(
      () => parseEventSeed(value),
      { message },
      JSON.stringify(value),
    );
  }
});

test("the seed tool, run through a symlink, names a malformed file without quoting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-seed-"));
  try {
    const link = join(dir, "seed.ts");
    symlinkSync(fileURLToPath(new URL("./seed.ts", import.meta.url)), link);
    const env = {
      PATH: process.env.PATH ?? "",
      DATABASE_PATH: join(dir, "limen.db"),
    };
    const usage = spawnSync(process.execPath, [link], {
      env,
      encoding: "utf8",
    });
    assert.equal(usage.status, 1);
    assert.equal(
      usage.stderr,
      "limen seed: usage: npm run seed -w @limen/api -- <seed file>\n",
    );
    for (const [content, owed] of [
      [
        "{stations: [Front-desk-marker]}",
        "is not valid JSON at line 1, column 2",
      ],
      ["[Front-desk-marker]", "is not valid JSON"],
      ['{"stations": []', "is not valid JSON at line 1, column 16"],
    ] as const) {
      const file = join(dir, "event.json");
      writeFileSync(file, content);
      const bad = spawnSync(process.execPath, [link, file], {
        env,
        encoding: "utf8",
      });
      assert.equal(bad.status, 1);
      assert.equal(bad.stderr, `limen seed: seed file ${file} ${owed}\n`);
      assert.ok(!bad.stderr.includes("marker"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the seed reads its clock inside its transaction: a seed that waits for the database is judged at the time it writes", () => {
  const db = openDatabase(":memory:");
  seedEvent(
    db,
    { stations: [], sessions: [session("s1", 10_100, 10_600)] },
    at(9_000),
  );
  // Taking the write lock takes 100 s here, as it would behind another writer. Before it, s1
  // starts in 100 s and may change; once it is taken, s1 has started.
  let clock = 10_000;
  const reads: string[] = [];
  const waiting = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "exec")
        return (sql: string) => {
          if (sql === "BEGIN IMMEDIATE") {
            reads.push("BEGIN");
            clock += 100;
          }
          return target.exec(sql);
        };
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  assert.throws(
    () =>
      seedEvent(
        waiting,
        { stations: [], sessions: [session("s1", 10_200, 10_600)] },
        () => {
          reads.push(`clock ${clock}`);
          return clock;
        },
      ),
    /s1 has started, or starts within 60 s, so it may only change by ending later/,
  );
  assert.deepEqual(reads, ["BEGIN", "clock 10100"]);
  assert.deepEqual(sessionRows(db), [
    { id: "s1", starts_at: 10_100, ends_at: 10_600 },
  ]);
});
