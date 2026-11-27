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

test("the demo seed writes the front desk station and the build window session in Unix seconds", () => {
  const db = openDatabase(":memory:");
  assert.deepEqual(seedEvent(db, parseEventSeed(DEMO), 1_795_700_000), {
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
  seedEvent(db, seed, 1);
  seedEvent(
    db,
    { ...seed, stations: [{ id: "st-front", name: "Main desk" }] },
    2,
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
