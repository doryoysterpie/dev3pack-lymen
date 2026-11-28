// E-11 done test: two bundles from different devices for one drainer produce one case with two
// sightings, and the D-05 threshold fires only on the owed conditions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openDatabase } from "./db.ts";
import { parseReport, storeReport } from "./evidence.ts";
import {
  autoEscalates,
  bundledLists,
  dedupHash,
  domainListed,
  holdQueue,
  normalizeHostname,
  parseDomainLists,
  triageSighting,
  type ThresholdInputs,
  type TriageOutcome,
} from "./triage.ts";

const FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/reports/e10-reports.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RECIPIENT = "FZegoJg97QC3nCnjTqW473XZK2osgy2xX5vRq8zccu2o";
const OTHER_RECIPIENT = "4FLJyfdzkWbs2yhhpymoZkudtsuJ3S8A8ft81gTWAPRa";
const lists = bundledLists();
let clock = 1_795_100_000;

/** Stores a fixture report with overrides, as the report route would, and returns its sighting. */
function store(
  db: DatabaseSync,
  name: string,
  overrides: Record<string, unknown> = {},
): number {
  const result = parseReport(
    {
      ...structuredClone(FIXTURES[name]),
      ...overrides,
    },
    clock,
  );
  assert.ok(result.ok);
  return storeReport(db, result.report, clock++);
}

/** Sets a bundle's recorded re-simulation outcome, the state E-10 leaves after re-simulating. */
function resimulated(
  db: DatabaseSync,
  sightingId: number,
  matches: boolean,
  drain: boolean,
): void {
  db.prepare(
    "UPDATE evidence_bundles SET resimulated_at = 1, resimulation_matches = ?, drain_pattern = ? WHERE sighting_id = ?",
  ).run(matches ? 1 : 0, drain ? 1 : 0, sightingId);
}

/** Stores a report, records a re-simulation that reproduced a drain summary, and triages it. */
function drainReport(
  db: DatabaseSync,
  name: string,
  overrides: Record<string, unknown> = {},
): TriageOutcome {
  const id = store(db, name, overrides);
  resimulated(db, id, true, true);
  return triageSighting(db, id, lists, clock++);
}

const device = (n: number): string =>
  `fixture-device-${String(n).padStart(2, "0")}-0123456789`;

test("E-11 done test: two bundles from different devices for one drainer produce one case with two sightings", () => {
  const db = openDatabase(":memory:");
  const first = triageSighting(
    db,
    store(db, "drainer_device_1"),
    lists,
    clock++,
  );
  const second = triageSighting(
    db,
    store(db, "drainer_device_2"),
    lists,
    clock++,
  );
  // The two bundles differ in transaction bytes, victim wallet and device, and share the domain,
  // the program set and the recipient set.
  assert.notEqual(
    FIXTURES.drainer_device_1.transaction,
    FIXTURES.drainer_device_2.transaction,
  );
  assert.equal(first.createdCase, true);
  assert.equal(second.createdCase, false);
  assert.equal(second.case.id, first.case.id);
  assert.equal(second.case.sightings, 2);
  assert.equal(second.case.inputs.independentDevices, 2);
  assert.equal(second.case.domain, "claim-pass.example");
  assert.deepEqual(second.case.programIds, [SYSTEM]);
  assert.deepEqual(second.case.recipients, [RECIPIENT]);
  const { n } = db.prepare("SELECT count(*) AS n FROM cases").get() as {
    n: number;
  };
  assert.equal(n, 1);
});

test("the dedup hash is SHA-256 of the canonical key, and ignores set order and repeats", () => {
  // The owed hash was computed with shasum over the canonical JSON text, not with this code.
  const key = {
    domain: "claim-pass.example",
    programIds: [SYSTEM],
    recipients: [RECIPIENT],
  };
  assert.equal(
    dedupHash(key),
    "51560a36a713ec945ac5ca08ff56ba0cc57c1d0dc5f4baa7c90d0a003584134f",
  );
  assert.equal(
    dedupHash({
      domain: "claim-pass.example",
      programIds: [TOKEN, SYSTEM],
      recipients: [],
    }),
    dedupHash({
      domain: "claim-pass.example",
      programIds: [SYSTEM, TOKEN, SYSTEM],
      recipients: [],
    }),
  );
});

test("a different domain, program set or recipient set makes a different case", () => {
  const db = openDatabase(":memory:");
  const base = triageSighting(db, store(db, "drainer_device_1"), lists, clock++)
    .case.id;
  const variants = [
    { url: "https://other-claim.example/api/tx" },
    { url: null, transaction: null, simulation: null },
    { program_ids: [SYSTEM, TOKEN] },
    { recipients: [RECIPIENT, OTHER_RECIPIENT] },
  ];
  const ids = variants.map(
    (v) =>
      triageSighting(db, store(db, "drainer_device_1", v), lists, clock++).case
        .id,
  );
  assert.equal(new Set([base, ...ids]).size, 5);
  // The same domain with a different path is the same case.
  const samePath = triageSighting(
    db,
    store(db, "drainer_device_2", {
      url: "https://claim-pass.example/other?x=1",
    }),
    lists,
    clock++,
  );
  assert.equal(samePath.case.id, base);
});

test("the same device reporting twice is two sightings but one independent device", () => {
  const db = openDatabase(":memory:");
  triageSighting(db, store(db, "drainer_device_1"), lists, clock++);
  const again = triageSighting(
    db,
    store(db, "drainer_device_2", { device_id: device(1) }),
    lists,
    clock++,
  );
  assert.equal(again.case.sightings, 2);
  assert.equal(again.case.inputs.independentDevices, 1);
});

test("E-11 done test: the threshold function gives the D-05 answer for every combination of inputs", () => {
  // Owed answers, written out from the D-05 text: drain AND (devices >= 2 OR listed).
  const owed: [boolean, number, boolean, boolean][] = [
    [false, 0, false, false],
    [false, 1, false, false],
    [false, 1, true, false],
    [false, 2, false, false],
    [false, 2, true, false],
    [false, 3, true, false],
    [true, 0, false, false],
    [true, 1, false, false],
    [true, 0, true, true],
    [true, 1, true, true],
    [true, 2, false, true],
    [true, 2, true, true],
    [true, 3, false, true],
  ];
  for (const [
    drainPattern,
    independentDevices,
    domainListed,
    escalates,
  ] of owed) {
    const inputs: ThresholdInputs = {
      drainPattern,
      independentDevices,
      domainListed,
    };
    assert.equal(autoEscalates(inputs), escalates, JSON.stringify(inputs));
  }
});

test("E-11 done test: a drain case from one device on an unlisted domain holds, and escalates on a second device", () => {
  const db = openDatabase(":memory:");
  const one = drainReport(db, "drainer_device_1");
  assert.deepEqual(one.case.inputs, {
    drainPattern: true,
    independentDevices: 1,
    domainListed: false,
  });
  assert.equal(one.case.status, "held");
  assert.equal(one.case.decidedBy, null);
  assert.equal(one.escalatedNow, false);

  const two = drainReport(db, "drainer_device_2");
  assert.equal(two.case.id, one.case.id);
  assert.equal(two.case.status, "escalated");
  assert.equal(two.case.decidedBy, "threshold");
  assert.equal(two.escalatedNow, true);

  // A third sighting leaves it escalated and does not escalate it again.
  const three = drainReport(db, "drainer_device_2", { device_id: device(3) });
  assert.equal(three.case.status, "escalated");
  assert.equal(three.escalatedNow, false);
});

test("E-11 done test: a drain case from one device escalates when its domain is on either list", () => {
  const db = openDatabase(":memory:");
  for (const host of [
    "listed-on-phantom.example",
    "listed-on-phishdestroy.example",
  ]) {
    const outcome = drainReport(db, "drainer_device_1", {
      url: `https://${host}/api/tx`,
    });
    assert.equal(outcome.case.inputs.independentDevices, 1);
    assert.equal(outcome.case.inputs.domainListed, true, host);
    assert.equal(outcome.case.status, "escalated", host);
  }
});

test("E-11 done test: without a reproduced drain pattern, two devices and a listed domain still hold", () => {
  const db = openDatabase(":memory:");
  const url = "https://listed-on-phantom.example/api/tx";
  // No re-simulation ran.
  triageSighting(db, store(db, "drainer_device_1", { url }), lists, clock++);
  const unverified = triageSighting(
    db,
    store(db, "drainer_device_2", { url }),
    lists,
    clock++,
  );
  assert.deepEqual(unverified.case.inputs, {
    drainPattern: false,
    independentDevices: 2,
    domainListed: true,
  });
  assert.equal(unverified.case.status, "held");

  // A re-simulation that shows a drain pattern but does not reproduce the stored summary.
  const other = { url: "https://wallet-drain.test/api/tx" };
  for (const name of ["drainer_device_1", "drainer_device_2"]) {
    const id = store(db, name, other);
    resimulated(db, id, false, true);
    const outcome = triageSighting(db, id, lists, clock++);
    assert.equal(outcome.case.inputs.drainPattern, false);
    assert.equal(outcome.case.status, "held");
  }

  // A reproduced summary with no drain pattern.
  for (const name of ["drainer_device_1", "drainer_device_2"]) {
    const id = store(db, name);
    resimulated(db, id, true, false);
    assert.equal(triageSighting(db, id, lists, clock++).case.status, "held");
  }
});

test("hostnames are normalized: lower case, punycode, and one trailing dot dropped", () => {
  // "bücher" is the punycode example "xn--bcher-kva" from the IDNA documentation.
  assert.equal(
    normalizeHostname("Listed-On-Phantom.Example."),
    "listed-on-phantom.example",
  );
  assert.equal(normalizeHostname("bücher.example"), "xn--bcher-kva.example");
  assert.equal(normalizeHostname("listed-on-phantom.example.."), null);
  assert.equal(normalizeHostname("Bad Domain"), null);
  const unicodeList = parseDomainLists({
    phantom: ["bücher.example"],
    phishdestroy: [],
  });
  assert.equal(domainListed("xn--bcher-kva.example", unicodeList), true);
});

test("a trailing dot no longer escapes the list or splits the case", () => {
  const db = openDatabase(":memory:");
  const plain = drainReport(db, "drainer_device_1", {
    url: "https://listed-on-phantom.example/api/tx",
  });
  const dotted = drainReport(db, "drainer_device_2", {
    url: "https://Listed-On-Phantom.Example./api/tx",
  });
  assert.equal(dotted.case.id, plain.case.id);
  assert.equal(dotted.case.domain, "listed-on-phantom.example");
  assert.equal(dotted.case.inputs.domainListed, true);
  assert.equal(plain.case.status, "escalated");
  // On its own, the dotted form is listed and escalates.
  const alone = openDatabase(":memory:");
  const only = drainReport(alone, "drainer_device_2", {
    url: "https://listed-on-phantom.example./api/tx",
  });
  assert.equal(only.case.status, "escalated");
});

test("a listed domain matches only by exact hostname, in any case", () => {
  assert.equal(domainListed("listed-on-phantom.example", lists), true);
  assert.equal(domainListed("LISTED-ON-PHANTOM.example", lists), true);
  assert.equal(domainListed("sub.listed-on-phantom.example", lists), false);
  assert.equal(domainListed("claim-pass.example", lists), false);
  assert.equal(domainListed(null, lists), false);
});

test("the bundled lists are the fixture lists, and a malformed list fails at load", () => {
  assert.deepEqual([...lists.phantom].sort(), [
    "listed-on-phantom.example",
    "wallet-drain.test",
  ]);
  assert.deepEqual([...lists.phishdestroy], ["listed-on-phishdestroy.example"]);
  assert.throws(() => parseDomainLists({ phantom: [] }), /phishdestroy/);
  assert.throws(
    () => parseDomainLists({ phantom: ["Bad Domain"], phishdestroy: [] }),
    /phantom/,
  );
  assert.throws(() => parseDomainLists(null), /expected an object/);
});

test("the hold queue lists held cases only, most recently updated first", () => {
  const db = openDatabase(":memory:");
  const a = triageSighting(db, store(db, "drainer_device_1"), lists, 100).case
    .id;
  const b = triageSighting(
    db,
    store(db, "drainer_device_1", { url: "https://other-claim.example/" }),
    lists,
    200,
  ).case.id;
  const escalated = drainReport(db, "drainer_device_1", {
    url: "https://listed-on-phantom.example/",
  });
  assert.equal(escalated.case.status, "escalated");
  assert.deepEqual(
    holdQueue(db, lists).map((c) => c.id),
    [b, a],
  );
  // A new sighting moves case a to the front.
  triageSighting(db, store(db, "drainer_device_2"), lists, 300);
  assert.deepEqual(
    holdQueue(db, lists).map((c) => c.id),
    [a, b],
  );
});
