// E-10: evidence bundle checks, storage and re-simulation against fixtures/reports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Fetch } from "@limen/preflight";

import { decodeBase58 } from "./base58.ts";
import { openDatabase } from "./db.ts";
import {
  canonicalJson,
  decodedPart,
  DEVNET_RPC_URL,
  loadBundle,
  MAX_CLOCK_AHEAD_S,
  MAX_DATE_SECONDS,
  MAX_TRANSACTION_BYTES,
  parseReport,
  preflightResimulator,
  RESIMULATION_TIMEOUT_MS,
  resimulateBundle,
  storeReport,
  type Report,
} from "./evidence.ts";
import { RESIMULATION_FIXTURE } from "./resimulation-fixture.ts";

type Body = Record<string, unknown>;

const FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/reports/e10-reports.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Body>;

const fixture = (name: string): Body => structuredClone(FIXTURES[name]);

/** The server clock the tests parse against: after both fixture timestamps. */
const NOW = 1_795_000_100;

function parsed(body: unknown): Report {
  const result = parseReport(body, NOW);
  assert.ok(
    result.ok,
    `report should parse, failed on ${result.ok ? "" : result.field}`,
  );
  return result.report;
}

function failedField(body: unknown, now: number = NOW): string {
  const result = parseReport(body, now);
  assert.equal(result.ok, false);
  return result.ok ? "" : result.field;
}

const RECIPIENT = "FZegoJg97QC3nCnjTqW473XZK2osgy2xX5vRq8zccu2o";
const VICTIM_1 = "4FLJyfdzkWbs2yhhpymoZkudtsuJ3S8A8ft81gTWAPRa";

/** The outcome of a simulation that ran without an error. */
const RAN = {
  status: "ran",
  err: null,
  changes: [
    { kind: "sol", account: "user", before: "5000000000", after: "9995000" },
  ],
};

/**
 * A summary in the pre-flight report's shape (E-09 toReport): the decoded instructions in
 * `summary`, beside whether limen set the fee payer, the simulation's outcome, and what that
 * outcome and the signers mean for signing.
 */
function preflightReport(
  lamports: string,
  rest: {
    feePayerSet?: boolean;
    cosigners?: { address: string; signed: boolean }[];
    simulation?: unknown;
    blocks?: string[];
  } = {},
) {
  return {
    kind: "ready",
    feePayerSet: rest.feePayerSet ?? false,
    summary: {
      effects: [
        {
          kind: "sol-out",
          instruction: 0,
          to: { address: RECIPIENT },
          lamports,
          reason: "transfer",
        },
      ],
      others: [],
      undecoded: [],
      signers: {
        feePayer: "user",
        others: rest.cosigners ?? [],
        unsigned: true,
      },
      unresolvedAccounts: 0,
    },
    simulation: rest.simulation ?? RAN,
    blocks: rest.blocks ?? [],
  };
}

/** The same JSON value with every object's keys in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, inner]) => [key, reversedKeys(inner)]),
  );
}

test("a stored fixture report loads back with every owed bundle field and no wallet field", () => {
  const db = openDatabase(":memory:");
  const body = fixture("drainer_device_1");
  const id = storeReport(db, parsed(body), 1_795_000_100);
  const bundle = loadBundle(db, id);
  assert.ok(bundle);
  assert.equal(bundle.sightingId, id);
  assert.equal(bundle.receivedAt, 1_795_000_100);
  assert.equal(
    bundle.payload,
    "solana:https%3A%2F%2Fclaim-pass.example%2Fapi%2Ftx",
  );
  assert.equal(bundle.url, "https://claim-pass.example/api/tx");
  assert.ok(bundle.transaction);
  assert.equal(
    Buffer.from(bundle.transaction).toString("base64"),
    body.transaction,
  );
  assert.deepEqual(bundle.simulation, {
    slot: 350_000_001,
    blockhash: "8RWypr3wHNpUThtiPVXTVa83Pye1BkSj9jthDVsDvwDg",
  });
  assert.equal(
    bundle.summaryJson,
    `{"effects":[{"lamports":"1500000001","to":"${RECIPIENT}","type":"sol_out"}],"kind":"transaction"}`,
  );
  assert.deepEqual(bundle.programIds, ["11111111111111111111111111111111"]);
  assert.deepEqual(bundle.recipients, [RECIPIENT]);
  assert.equal(bundle.reportedAt, 1_795_000_001);
  assert.equal(bundle.appVersion, "0.1.0");
  // The fixture sends a wallet without the opt-in, so none is stored.
  assert.equal(body.wallet, VICTIM_1);
  assert.equal(bundle.wallet, null);
  assert.equal(bundle.resimulation, null);
  // The device ID is stored only as its hash (SHA-256 computed with shasum, not this code).
  assert.equal(
    bundle.deviceHash,
    "56f1fa47c2de2c2ddd99c6fbe9c5942ac90ab0b01984171ace2508c15bcc306e",
  );
  const raw = db.prepare("SELECT * FROM sightings").all();
  assert.equal(JSON.stringify(raw).includes("fixture-device-01"), false);
  // The wallet field is not stored: the victim's address appears in no column as text.
  const stored = db.prepare("SELECT * FROM evidence_bundles").all();
  assert.equal(JSON.stringify(stored).includes(VICTIM_1), false);
  // The transaction bytes still name the signing wallet, as account key 0: bytes 69 to 100,
  // after one signature count byte, a 64-byte signature, a 3-byte header and a key count byte.
  assert.ok(bundle.transaction);
  assert.deepEqual(
    Buffer.from(bundle.transaction.subarray(69, 101)),
    Buffer.from(decodeBase58(VICTIM_1) ?? []),
  );
});

test("the timestamp may be at most 300 s ahead of the server's clock and inside the Date range", () => {
  const body = fixture("drainer_device_1");
  assert.equal(MAX_CLOCK_AHEAD_S, 300);
  assert.equal(parsed({ ...body, timestamp: NOW + 300 }).reportedAt, NOW + 300);
  assert.equal(failedField({ ...body, timestamp: NOW + 301 }), "timestamp");
  // Milliseconds sent as seconds land far in the future and are refused.
  assert.equal(failedField({ ...body, timestamp: NOW * 1000 }), "timestamp");
  // 8640000000000 s is the last second a JavaScript Date can hold.
  assert.equal(MAX_DATE_SECONDS, 8_640_000_000_000);
  assert.equal(
    new Date(MAX_DATE_SECONDS * 1000).toISOString(),
    "+275760-09-13T00:00:00.000Z",
  );
  const late = MAX_DATE_SECONDS;
  const atLimit = parseReport({ ...body, timestamp: late }, late);
  assert.equal(atLimit.ok, true);
  assert.equal(
    failedField({ ...body, timestamp: late + 1 }, late),
    "timestamp",
  );
  assert.equal(
    failedField({ ...body, timestamp: Number.MAX_SAFE_INTEGER }, late),
    "timestamp",
  );
});

test("the wallet is stored only when the report opts in with include_wallet", () => {
  const db = openDatabase(":memory:");
  const body = { ...fixture("drainer_device_1"), include_wallet: true };
  const bundle = loadBundle(db, storeReport(db, parsed(body), 1));
  assert.equal(bundle?.wallet, VICTIM_1);
  assert.equal(failedField({ ...body, wallet: undefined }), "wallet");
  assert.equal(failedField({ ...body, wallet: "not-a-key" }), "wallet");
});

test("program IDs and recipients are stored sorted and deduplicated", () => {
  const body = fixture("drainer_device_1");
  const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  body.program_ids = [token, "11111111111111111111111111111111", token];
  body.recipients = [RECIPIENT, VICTIM_1, RECIPIENT];
  const report = parsed(body);
  assert.deepEqual(report.programIds, [
    "11111111111111111111111111111111",
    token,
  ]);
  assert.deepEqual(report.recipients, [VICTIM_1, RECIPIENT]);
});

test("a link report with no transaction and no simulation is accepted", () => {
  const body = fixture("drainer_device_1");
  body.transaction = null;
  body.simulation = null;
  const report = parsed(body);
  assert.equal(report.transaction, null);
  assert.equal(report.simulation, null);
});

test("each malformed field is refused and named", () => {
  const base = fixture("drainer_device_1");
  const cases: [Body | unknown, string][] = [
    [[], "body"],
    [{ ...base, extra: 1 }, "extra"],
    [{ ...base, device_id: "short" }, "device_id"],
    [{ ...base, payload: "" }, "payload"],
    [{ ...base, url: "ftp://claim-pass.example/" }, "url"],
    [{ ...base, transaction: "AQ" }, "transaction"],
    [{ ...base, transaction: "" }, "transaction"],
    [
      {
        ...base,
        transaction: Buffer.alloc(MAX_TRANSACTION_BYTES + 1).toString("base64"),
      },
      "transaction",
    ],
    [{ ...base, transaction: null }, "simulation"],
    [{ ...base, simulation: { slot: -1, blockhash: RECIPIENT } }, "simulation"],
    [{ ...base, simulation: { slot: 1, blockhash: "x" } }, "simulation"],
    [{ ...base, summary: [] }, "summary"],
    [{ ...base, summary: "drain" }, "summary"],
    [{ ...base, program_ids: ["nope"] }, "program_ids"],
    [{ ...base, recipients: "nope" }, "recipients"],
    [{ ...base, timestamp: 1.5 }, "timestamp"],
    [{ ...base, app_version: "" }, "app_version"],
    [{ ...base, include_wallet: "yes" }, "include_wallet"],
  ];
  for (const [body, field] of cases)
    assert.equal(failedField(body), field, field);
});

test("canonical JSON sorts object keys at every depth and keeps array order", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }),
    '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
  );
  assert.throws(() => canonicalJson({ n: 1n }), TypeError);
  assert.throws(() => canonicalJson({ n: Infinity }), TypeError);
});

test("re-simulation receives exactly the stored bytes and records whether the summary matches", async () => {
  const db = openDatabase(":memory:");
  const stored = preflightReport("4990000000");
  const body: Body = { ...fixture("drainer_device_1"), summary: stored };
  const id = storeReport(db, parsed(body), 1);
  const seen: string[] = [];

  // The same summary with its keys in another order, at every depth, matches.
  const reordered = await resimulateBundle(
    db,
    id,
    async (tx) => {
      seen.push(Buffer.from(tx).toString("base64"));
      return { summary: reversedKeys(stored), drainPattern: true };
    },
    10,
  );
  assert.equal(reordered.status, "resimulated");
  assert.equal(reordered.status === "resimulated" && reordered.matches, true);
  assert.deepEqual(seen, [body.transaction]);
  assert.deepEqual(loadBundle(db, id)?.resimulation, {
    at: 10,
    matches: true,
    drainPattern: true,
  });

  // A summary with one changed amount does not match, and the record says so.
  const changed = preflightReport("1");
  const differs = await resimulateBundle(
    db,
    id,
    async () => ({ summary: changed, drainPattern: false }),
    11,
  );
  assert.equal(differs.status === "resimulated" && differs.matches, false);
  assert.deepEqual(loadBundle(db, id)?.resimulation, {
    at: 11,
    matches: false,
    drainPattern: false,
  });
});

test("a failed re-simulation is recorded, keeps the report, and leaves any earlier outcome", async () => {
  const db = openDatabase(":memory:");
  const body = fixture("drainer_device_1");
  const id = storeReport(db, parsed(body), 1);
  const throwing = async (): Promise<never> => {
    throw new Error("rpc down");
  };
  assert.deepEqual(await resimulateBundle(db, id, throwing, 20), {
    status: "failed",
  });
  assert.equal(loadBundle(db, id)?.resimulationFailedAt, 20);
  assert.equal(loadBundle(db, id)?.resimulation, null);

  // A later success records its outcome and clears the failure.
  await resimulateBundle(
    db,
    id,
    async () => ({ summary: body.summary, drainPattern: true }),
    30,
  );
  assert.equal(loadBundle(db, id)?.resimulationFailedAt, null);
  // A failure after that leaves the successful outcome in place.
  assert.deepEqual(await resimulateBundle(db, id, throwing, 40), {
    status: "failed",
  });
  assert.deepEqual(loadBundle(db, id)?.resimulation, {
    at: 30,
    matches: true,
    drainPattern: true,
  });
  assert.equal(loadBundle(db, id)?.resimulationFailedAt, 40);

  // A summary that JSON cannot hold fails the same way.
  assert.deepEqual(
    await resimulateBundle(
      db,
      id,
      async () => ({ summary: { lamports: 1n }, drainPattern: true }),
      50,
    ),
    { status: "failed" },
  );
  const { n } = db.prepare("SELECT count(*) AS n FROM sightings").get() as {
    n: number;
  };
  assert.equal(n, 1);
});

test("a re-simulation that never answers counts as failed after the time limit", async () => {
  assert.equal(RESIMULATION_TIMEOUT_MS, 15_000);
  const db = openDatabase(":memory:");
  const id = storeReport(db, parsed(fixture("drainer_device_1")), 1);
  const never = (): Promise<never> => new Promise(() => {});
  const started = Date.now();
  assert.deepEqual(await resimulateBundle(db, id, never, 60, 20), {
    status: "failed",
  });
  assert.ok(
    Date.now() - started < 5_000,
    "answered well before any client timeout",
  );
  assert.equal(loadBundle(db, id)?.resimulationFailedAt, 60);
  assert.equal(loadBundle(db, id)?.resimulation, null);
});

test("a re-simulation matches on the decoded instructions, not on drifting balances (owner ruling 7a)", async () => {
  // The simulation's balance changes drift as account state moves.
  const db = openDatabase(":memory:");
  const stored = preflightReport("4990000000");
  const id = storeReport(
    db,
    parsed({ ...fixture("drainer_device_1"), summary: stored }),
    1,
  );

  // Same instructions, different balances: the wallet held less when the server re-simulated.
  const drifted = preflightReport("4990000000", {
    simulation: {
      ...RAN,
      changes: [
        { kind: "sol", account: "user", before: "2000000000", after: "0" },
      ],
    },
  });
  const same = await resimulateBundle(
    db,
    id,
    async () => ({ summary: drifted, drainPattern: true }),
    10,
  );
  assert.equal(same.status === "resimulated" && same.matches, true);
  assert.deepEqual(loadBundle(db, id)?.resimulation, {
    at: 10,
    matches: true,
    drainPattern: true,
  });

  // One decoded instruction changed: a different amount leaves the wallet.
  const changed = preflightReport("1");
  const differs = await resimulateBundle(
    db,
    id,
    async () => ({ summary: changed, drainPattern: false }),
    11,
  );
  assert.equal(differs.status === "resimulated" && differs.matches, false);
  assert.deepEqual(loadBundle(db, id)?.resimulation, {
    at: 11,
    matches: false,
    drainPattern: false,
  });
});

test("a report whose request left the fee payer unset matches the replay of its stored bytes (owner ruling 7a)", async () => {
  // The app stores the transaction it rebuilt with the wallet as fee payer, so its report says
  // limen set the fee payer, while the server's replay of those stored bytes finds it already set.
  const db = openDatabase(":memory:");
  const id = storeReport(
    db,
    parsed({
      ...fixture("drainer_device_1"),
      summary: preflightReport("4990000000", { feePayerSet: true }),
    }),
    1,
  );
  const replay = preflightReport("4990000000", { feePayerSet: false });
  const outcome = await resimulateBundle(
    db,
    id,
    async () => ({ summary: replay, drainPattern: true }),
    10,
  );
  assert.equal(outcome.status === "resimulated" && outcome.matches, true);
  assert.deepEqual(loadBundle(db, id)?.resimulation, {
    at: 10,
    matches: true,
    drainPattern: true,
  });
});

test("a replay whose simulation failed matches when its decoded instructions are the same (owner ruling 7a)", async () => {
  // simulation-failed comes from the simulation's outcome, here an account state that moved
  // between the report and the replay, not from the decoded instructions.
  const db = openDatabase(":memory:");
  const id = storeReport(
    db,
    parsed({
      ...fixture("drainer_device_1"),
      summary: preflightReport("4990000000"),
    }),
    1,
  );
  const failed = preflightReport("4990000000", {
    simulation: {
      status: "ran",
      err: { InstructionError: [0, { Custom: 1 }] },
      changes: [],
    },
    blocks: ["simulation-failed"],
  });
  const outcome = await resimulateBundle(
    db,
    id,
    async () => ({ summary: failed, drainPattern: true }),
    10,
  );
  assert.equal(outcome.status === "resimulated" && outcome.matches, true);

  // cosigner-missing comes from the decoded signers, so a replay that finds another signature
  // missing does not match.
  const cosigner = preflightReport("4990000000", {
    cosigners: [{ address: VICTIM_1, signed: false }],
    blocks: ["cosigner-missing"],
  });
  const differs = await resimulateBundle(
    db,
    id,
    async () => ({ summary: cosigner, drainPattern: true }),
    11,
  );
  assert.equal(differs.status === "resimulated" && differs.matches, false);
});

test("the decoded part keeps only the report's kind and summary", () => {
  assert.deepEqual(
    decodedPart({
      kind: "ready",
      feePayerSet: true,
      summary: { simulation: 1, blocks: [] },
      simulation: 2,
      blocks: ["simulation-failed"],
    }),
    { kind: "ready", summary: { simulation: 1, blocks: [] } },
  );
  // A refusal has no summary, so it compares on its kind alone, with no undefined field left
  // for canonical JSON to refuse.
  assert.equal(
    canonicalJson(decodedPart({ kind: "malformed", problem: "truncated" })),
    '{"kind":"malformed"}',
  );
  assert.equal(decodedPart(null), null);
});

test("re-simulation of a bundle with no transaction or no bundle runs nothing", async () => {
  const db = openDatabase(":memory:");
  const body = fixture("drainer_device_1");
  body.transaction = null;
  body.simulation = null;
  const id = storeReport(db, parsed(body), 1);
  const never = async (): Promise<never> => {
    throw new Error("must not run");
  };
  assert.deepEqual(await resimulateBundle(db, id, never, 2), {
    status: "no_transaction",
  });
  assert.deepEqual(await resimulateBundle(db, 999, never, 2), {
    status: "no_bundle",
  });
});

/** Serves recorded JSON-RPC responses over loopback HTTP with zero network access. */
async function withLocalRpcServer<T>(
  handle: (
    method: string,
    params: readonly unknown[],
  ) => {
    readonly status?: number;
    readonly body: Record<string, unknown>;
  },
  run: (localFetch: Fetch, seenMethods: string[]) => Promise<T>,
): Promise<T> {
  const seenMethods: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
        params: unknown[];
      };
      seenMethods.push(request.method);
      const reply = handle(request.method, request.params);
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        ...reply.body,
      });
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
      });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const localFetch: Fetch = async (url, init) => {
    assert.equal(url, DEVNET_RPC_URL);
    const response = await fetch(`http://127.0.0.1:${port}`, init);
    return {
      ok: response.ok,
      status: response.status,
      url,
      text: await response.text(),
    };
  };
  try {
    return await run(localFetch, seenMethods);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("E-10 done test: a stored bundle re-simulates to the same summary from the stored bytes", async () => {
  const db = openDatabase(":memory:");
  const bundleBody = structuredClone(RESIMULATION_FIXTURE.bundle);
  // The fixture leaves out `wallet`, so the re-simulator must read the fee payer from the bytes.
  assert.equal(bundleBody.wallet, undefined);
  const id = storeReport(db, parsed(bundleBody), NOW);

  await withLocalRpcServer(
    (method) => ({
      body: { result: RESIMULATION_FIXTURE.rpcResponses[method] },
    }),
    async (localFetch, seenMethods) => {
      const resimulate = preflightResimulator({ fetch: localFetch });
      const outcome = await resimulateBundle(db, id, resimulate, NOW + 1);
      assert.equal(outcome.status, "resimulated");
      assert.equal(outcome.status === "resimulated" && outcome.matches, true);
      assert.equal(
        outcome.status === "resimulated" && outcome.drainPattern,
        true,
      );
      assert.deepEqual(seenMethods, ["getGenesisHash", "simulateTransaction"]);
      assert.deepEqual(loadBundle(db, id)?.resimulation, {
        at: NOW + 1,
        matches: true,
        drainPattern: true,
      });
      // Stored feePayerSet was true and simulation balances drifted, yet decodedPart matches.
      if (outcome.status === "resimulated") {
        const replayed = JSON.parse(outcome.summaryJson) as Record<
          string,
          unknown
        >;
        assert.equal(replayed.feePayerSet, false);
        assert.deepEqual(
          decodedPart(replayed),
          decodedPart(bundleBody.summary),
        );
      }
    },
  );
});

test("preflightResimulator refuses any RPC URL other than https://api.devnet.solana.com", () => {
  for (const badUrl of [
    "",
    "http://127.0.0.1:8899",
    "https://api.mainnet-beta.solana.com",
    "https://devnet.example/?api-key=secret-token",
  ]) {
    assert.throws(
      () => preflightResimulator({ url: badUrl }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "SOLANA_RPC_URL must be https://api.devnet.solana.com. limen re-simulates on devnet only.",
        );
        assert.equal(err.message.includes("secret-token"), false);
        return true;
      },
    );
  }
});

test("preflightResimulator records failure when the local RPC server reports a non-devnet cluster or outage", async () => {
  const db = openDatabase(":memory:");
  const id = storeReport(
    db,
    parsed(structuredClone(RESIMULATION_FIXTURE.bundle)),
    NOW,
  );

  // Non-devnet genesis hash must fail rather than compare a refusal against the stored bundle.
  await withLocalRpcServer(
    () => ({
      body: { result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" },
    }),
    async (localFetch) => {
      const resimulate = preflightResimulator({ fetch: localFetch });
      assert.deepEqual(await resimulateBundle(db, id, resimulate, NOW + 1), {
        status: "failed",
      });
      assert.equal(loadBundle(db, id)?.resimulationFailedAt, NOW + 1);
      assert.equal(loadBundle(db, id)?.resimulation, null);
    },
  );

  // HTTP 500 during simulation must fail rather than match an unrun decode.
  await withLocalRpcServer(
    (method) =>
      method === "getGenesisHash"
        ? { body: { result: RESIMULATION_FIXTURE.rpcResponses.getGenesisHash } }
        : { status: 500, body: { error: { code: -32000, message: "down" } } },
    async (localFetch) => {
      const resimulate = preflightResimulator({ fetch: localFetch });
      assert.deepEqual(await resimulateBundle(db, id, resimulate, NOW + 2), {
        status: "failed",
      });
      assert.equal(loadBundle(db, id)?.resimulationFailedAt, NOW + 2);
      assert.equal(loadBundle(db, id)?.resimulation, null);
    },
  );
});
