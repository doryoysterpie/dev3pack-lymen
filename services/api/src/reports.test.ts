// E-10 and E-11: the POST /reports route stores a fixture bundle, triages it into a case, and
// refuses malformed requests. Includes the first half of the E-11 done test, end to end.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { openDatabase } from "./db.ts";
import { loadBundle } from "./evidence.ts";
import { MAX_REPORT_BODY_BYTES } from "./reports.ts";
import { API_VERSION, createApiServer } from "./server.ts";
import { TEST_STATION_SETTINGS } from "./test-station.ts";

const FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/reports/e10-reports.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

/** A summary in the pre-flight report's shape (E-09 toReport) with one transfer of `lamports`. */
const preflightReport = (lamports: string) => ({
  kind: "ready",
  feePayerSet: false,
  summary: {
    effects: [
      {
        kind: "sol-out",
        instruction: 0,
        to: { address: "FZegoJg97QC3nCnjTqW473XZK2osgy2xX5vRq8zccu2o" },
        lamports,
        reason: "transfer",
      },
    ],
    others: [],
    undecoded: [],
    signers: { feePayer: "user", others: [], unsigned: true },
    unresolvedAccounts: 0,
  },
  simulation: { status: "ran", err: null, changes: [] },
  blocks: [],
});

const db = openDatabase(":memory:");
const servers: Server[] = [];
let base = "";
let resimBase = "";

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  base = await listen(
    createApiServer({
      db,
      version: API_VERSION,
      ...TEST_STATION_SETTINGS,
      reports: { now: () => 1_795_000_500 },
    }),
  );
  // A second server whose re-simulation returns a summary with one changed amount.
  resimBase = await listen(
    createApiServer({
      db: openDatabase(":memory:"),
      version: API_VERSION,
      ...TEST_STATION_SETTINGS,
      reports: {
        now: () => 1_795_000_600,
        resimulator: async () => ({
          summary: preflightReport("1"),
          drainPattern: false,
        }),
      },
    }),
  );
});

after(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

const post = (
  url: string,
  body: string,
  type = "application/json",
): Promise<Response> =>
  fetch(`${url}/reports`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });

test("POST /reports stores the fixture bundle as sighting 1 in a new held case 1, with no re-simulation", async () => {
  const res = await post(base, JSON.stringify(FIXTURES.drainer_device_1));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), {
    sighting_id: 1,
    resimulation: "not_run",
    case_id: 1,
    case_status: "held",
  });
  const row = db
    .prepare("SELECT case_id, created_at FROM sightings WHERE id = 1")
    .get() as {
    case_id: number | null;
    created_at: number;
  };
  assert.deepEqual({ ...row }, { case_id: 1, created_at: 1_795_000_500 });
  const bundle = loadBundle(db, 1);
  assert.equal(bundle?.url, "https://claim-pass.example/api/tx");
  assert.equal(bundle?.wallet, null);
});

test("with a re-simulator set, the response says whether the stored bytes re-simulated to the stored summary", async () => {
  const res = await post(
    resimBase,
    JSON.stringify({
      ...FIXTURES.drainer_device_2,
      summary: preflightReport("1500000001"),
    }),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), {
    sighting_id: 1,
    resimulation: "differs",
    case_id: 1,
    case_status: "held",
  });
});

test("a failing re-simulator still answers 201 once and stores one sighting, so a retry is not needed", async () => {
  const failingDb = openDatabase(":memory:");
  const failing = createApiServer({
    db: failingDb,
    version: API_VERSION,
    ...TEST_STATION_SETTINGS,
    reports: {
      now: () => 1_795_000_700,
      resimulator: async () => {
        throw new Error("rpc down");
      },
    },
  });
  const url = await listen(failing);
  const res = await post(url, JSON.stringify(FIXTURES.drainer_device_1));
  assert.equal(res.status, 201);
  // The report is stored once and still triaged: its sighting sits in a held case.
  assert.deepEqual(await res.json(), {
    sighting_id: 1,
    resimulation: "failed",
    case_id: 1,
    case_status: "held",
  });
  const rows = failingDb
    .prepare("SELECT resimulation_failed_at FROM evidence_bundles")
    .all() as { resimulation_failed_at: number }[];
  assert.deepEqual(
    rows.map((r) => r.resimulation_failed_at),
    [1_795_000_700],
  );
});

test("a re-simulator that never answers still gets 201 once, after the time limit", async () => {
  const hangingDb = openDatabase(":memory:");
  const hanging = createApiServer({
    db: hangingDb,
    version: API_VERSION,
    ...TEST_STATION_SETTINGS,
    reports: {
      now: () => 1_795_000_700,
      resimulator: () => new Promise(() => {}),
      resimulationTimeoutMs: 50,
    },
  });
  const url = await listen(hanging);
  const res = await post(url, JSON.stringify(FIXTURES.drainer_device_1));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), {
    sighting_id: 1,
    resimulation: "failed",
    case_id: 1,
    case_status: "held",
  });
  const { n } = hangingDb
    .prepare("SELECT count(*) AS n FROM sightings")
    .get() as {
    n: number;
  };
  assert.equal(n, 1);
});

test("a report with no transaction answers resimulation no_transaction when a re-simulator is set", async () => {
  const res = await post(
    resimBase,
    JSON.stringify({
      ...FIXTURES.drainer_device_1,
      transaction: null,
      simulation: null,
    }),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), {
    sighting_id: 2,
    resimulation: "no_transaction",
    case_id: 1,
    case_status: "held",
  });
});

test("a timestamp more than 300 s ahead of the server's clock is refused", async () => {
  const res = await post(
    base,
    JSON.stringify({ ...FIXTURES.drainer_device_1, timestamp: 1_795_000_801 }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "invalid_report",
    field: "timestamp",
  });
});

test("E-11 done test, end to end: a second bundle for the same drainer from another device joins case 1 as its second sighting", async () => {
  const res = await post(base, JSON.stringify(FIXTURES.drainer_device_2));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), {
    sighting_id: 2,
    resimulation: "not_run",
    case_id: 1,
    // No re-simulation ran, so no drain pattern is shown and the case holds for a human.
    case_status: "held",
  });
  const counts = db
    .prepare(
      "SELECT (SELECT count(*) FROM cases) AS cases, count(*) AS sightings, count(DISTINCT device_hash) AS devices FROM sightings WHERE case_id = 1",
    )
    .get() as Record<string, number>;
  assert.deepEqual({ ...counts }, { cases: 1, sightings: 2, devices: 2 });
});

test("a malformed report is refused with 400 naming the field, and nothing is stored", async () => {
  const before = (
    db.prepare("SELECT count(*) AS n FROM sightings").get() as { n: number }
  ).n;
  const res = await post(
    base,
    JSON.stringify({ ...FIXTURES.drainer_device_1, recipients: ["x"] }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "invalid_report",
    field: "recipients",
  });
  const afterCount = (
    db.prepare("SELECT count(*) AS n FROM sightings").get() as { n: number }
  ).n;
  assert.equal(afterCount, before);
});

test("a body that is not JSON gets 400, a non-JSON content type 415, and an oversized body 413", async () => {
  const notJson = await post(base, "{");
  assert.equal(notJson.status, 400);
  assert.deepEqual(await notJson.json(), { error: "invalid_json" });

  const wrongType = await post(
    base,
    JSON.stringify(FIXTURES.drainer_device_1),
    "text/plain",
  );
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), { error: "unsupported_media_type" });

  const huge = await post(base, " ".repeat(MAX_REPORT_BODY_BYTES + 1));
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), { error: "body_too_large" });
});

test("a method other than POST on /reports is refused with 405 and an Allow header", async () => {
  const res = await fetch(`${base}/reports`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});
