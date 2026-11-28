// E-13 done test: with the flag off nothing leaves the service; with the flag on, a dry run logs
// the exact request body. Both run end to end through POST /reports, with two fixture reports
// from different devices that escalate one drain case under D-05.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import {
  createServer as createNetServer,
  Socket,
  type AddressInfo,
} from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildChainabuseRequest,
  CHAINABUSE_REPORTS_URL,
  chainabuseHook,
  escapeMarkdown,
  NothingToReport,
  parseChainabuseMode,
  redactSummary,
  type ChainabuseMode,
} from "./chainabuse.ts";
import { openDatabase } from "./db.ts";
import { canonicalJson, loadBundle, type StoredBundle } from "./evidence.ts";
import { API_VERSION, createApiServer } from "./server.ts";
import {
  TEST_STATION_DISPLAY_SECRET,
  TEST_STATION_SETTINGS,
} from "./test-station.ts";
import { bundledLists, loadCase } from "./triage.ts";

const FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/reports/e10-reports.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;
const DEVICE_1 = FIXTURES.drainer_device_1!;
const DEVICE_2 = FIXTURES.drainer_device_2!;
const RECIPIENT = "FZegoJg97QC3nCnjTqW473XZK2osgy2xX5vRq8zccu2o";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Records every TCP connection and fetch that targets anything but this machine. */
function watchOutbound(): { outbound: string[]; restore: () => void } {
  const outbound: string[] = [];
  const realConnect = Socket.prototype.connect;
  const realFetch = globalThis.fetch;
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    // net.connect() hands its arguments over normalized, as [options, callback].
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const host =
      typeof first === "object" && first !== null && "host" in first
        ? String((first as { host?: unknown }).host ?? "localhost")
        : typeof first === "object" && first !== null && "path" in first
          ? "localhost"
          : typeof args[1] === "string"
            ? args[1]
            : "localhost";
    if (!LOOPBACK.has(host)) outbound.push(`tcp ${host}`);
    return (realConnect as (...a: unknown[]) => Socket).apply(this, args);
  } as typeof Socket.prototype.connect;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, "")))
      outbound.push(`fetch ${url.href}`);
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    outbound,
    restore: () => {
      Socket.prototype.connect = realConnect;
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Posts the reports (by default the two fixture reports) through a real server with the hook in
 * `mode`. Each transaction re-simulates to the summary its report carried, with a drain pattern.
 */
async function runFlow(
  mode: ChainabuseMode,
  include_wallet = false,
  reports: readonly Record<string, unknown>[] = [DEVICE_1, DEVICE_2],
) {
  const summaryByTx = new Map(
    reports.map((r) => [String(r.transaction), r.summary] as const),
  );
  const db = openDatabase(":memory:");
  const logged: string[] = [];
  const server: Server = createApiServer({
    db,
    version: API_VERSION,
    ...TEST_STATION_SETTINGS,
    reports: {
      now: () => 1_795_000_500,
      resimulator: async (tx) => ({
        summary: summaryByTx.get(Buffer.from(tx).toString("base64")),
        drainPattern: true,
      }),
      onEscalated: chainabuseHook(mode, db, bundledLists(), (line) =>
        logged.push(line),
      ),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const watch = watchOutbound();
  const statuses: unknown[] = [];
  try {
    for (const report of reports) {
      const res = await fetch(`${base}/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...report, include_wallet }),
      });
      statuses.push(await res.json());
    }
  } finally {
    watch.restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { db, logged, outbound: watch.outbound, statuses };
}

// The opening when the drain pattern may come from the decoded instructions or from a simulation
// that ran without an error, and the threshold line, as the body owes them.
const BOTH_SOURCES =
  "A QR reported through limen leads to a transaction with a drain pattern: its decoded instructions, or a simulation that ran without an error, show control of the signer's wallet or its token accounts handed over, or the wallet swept. limen simulates on Solana devnet only.";
const DECODED_ONLY =
  "A QR reported through limen leads to a transaction whose decoded instructions hand over control of the signer's wallet or its token accounts. Its simulation did not run without an error, so no simulated movement of funds is claimed. limen simulates on Solana devnet only.";
const THRESHOLD_LINE =
  "- Decided by: the automatic threshold (drain pattern, and two or more distinct reported install IDs or a domain on the bundled fixture list)";

// The body owed for the fixture case, written out from the inputs: case 1, escalated by the
// threshold on two devices and a reproduced drain; the domain of the reported URL; the one
// recipient; the System Program; the first device's summary, shown with its markers escaped.
const SUMMARY_1 = canonicalJson(DEVICE_1.summary);
const OWED_BODY = [
  {
    scamCategory: "PHISHING",
    description: [
      "### limen escalation: drain pattern",
      "",
      BOTH_SOURCES,
      "",
      "- Case: 1",
      THRESHOLD_LINE,
      "- Sightings: 2, from 2 distinct reported install IDs",
      "- Domain: claim-pass.example",
      "- Domain on the bundled fixture list: no",
      "- Re-simulation reproduced the reported summary with a drain pattern: yes",
      "",
      "#### Simulated transaction summary",
      `- effects: \\[{"lamports":"1500000001","to":"${RECIPIENT}","type":"sol\\_out"}\\]`,
      "- kind: transaction",
      "",
      "#### Programs",
      `- ${SYSTEM_PROGRAM}`,
      "",
      "#### Recipients as reported to limen",
      `- ${RECIPIENT}`,
    ].join("\n"),
    addresses: [
      { domain: "claim-pass.example", label: "Domain of the reported QR link" },
      {
        chain: "SOL",
        address: RECIPIENT,
        label: "Recipient as reported to limen",
      },
    ],
    evidences: [
      {
        source: `limen simulated transaction summary (Solana devnet): ${SUMMARY_1}`,
      },
    ],
  },
];

test("CHAINABUSE_POST is off unless set to dry-run, and any other value is refused", () => {
  assert.equal(parseChainabuseMode(undefined), "off");
  assert.equal(parseChainabuseMode(""), "off");
  assert.equal(parseChainabuseMode("off"), "off");
  assert.equal(parseChainabuseMode("dry-run"), "dry-run");
  for (const value of ["on", "true", "live", "1", "DRY-RUN"]) {
    assert.throws(() => parseChainabuseMode(value), {
      message: `CHAINABUSE_POST must be "off" or "dry-run", got "${value}". This build has no live mode.`,
    });
  }
});

test("E-13 done test: with the flag off, an escalation sends nothing, logs nothing and builds nothing", async () => {
  const { db, logged, outbound, statuses } = await runFlow("off");
  assert.deepEqual(
    statuses.map((s) => (s as { case_status: string }).case_status),
    ["held", "escalated"],
  );
  assert.deepEqual(logged, []);
  assert.deepEqual(outbound, []);
  // Off gives the report route no hook at all, so no request is built.
  assert.equal(
    chainabuseHook("off", db, bundledLists(), () => assert.fail("logged")),
    undefined,
  );
});

test("E-13 done test: with the flag on, the dry run logs the exact request body and sends nothing", async () => {
  const { logged, outbound, statuses } = await runFlow("dry-run");
  assert.deepEqual(
    statuses.map((s) => (s as { case_status: string }).case_status),
    ["held", "escalated"],
  );
  assert.equal(logged.length, 1, "one log entry, at the escalation");
  const [line, body, ...rest] = logged[0]!.split("\n");
  assert.equal(
    line,
    `chainabuse dry run, not sent: POST ${CHAINABUSE_REPORTS_URL}`,
  );
  assert.deepEqual(rest, []);
  assert.equal(body, JSON.stringify(OWED_BODY));
  assert.deepEqual(outbound, []);
});

test("the body never carries transaction bytes, the QR text, device IDs or a reporter's wallet, even when included", async () => {
  const { db, logged } = await runFlow("dry-run", true);
  // The reports did include the wallets, so the stored bundles hold them.
  assert.equal(loadBundle(db, 1)?.wallet, DEVICE_1.wallet);
  const text = logged.join("\n");
  for (const report of [DEVICE_1, DEVICE_2]) {
    for (const field of [
      "transaction",
      "wallet",
      "device_id",
      "payload",
      "url",
    ]) {
      assert.ok(
        !text.includes(String(report[field])),
        `${field} leaked into the request`,
      );
    }
  }
  assert.ok(!text.includes("/api/tx"), "the URL path leaked into the request");
});

test("the body keeps to Chainabuse's published schema for POST /v0/reports/batch", async () => {
  const { logged } = await runFlow("dry-run");
  const body = JSON.parse(logged[0]!.split("\n")[1]!) as Record<
    string,
    unknown
  >[];
  // From https://docs.chainabuse.com/reference/createreports (page updated 2025-09-08): the
  // body is an array of reports; each report allows only these keys (additionalProperties is
  // false) and requires addresses, description and scamCategory.
  const allowed = new Set([
    "accusedScammers",
    "addresses",
    "tokens",
    "transactionHashes",
    "agreedToBeContactedData",
    "categoryDescription",
    "compromiseIndicators",
    "description",
    "evidences",
    "losses",
    "scamCategory",
  ]);
  assert.ok(Array.isArray(body) && body.length === 1);
  for (const report of body) {
    for (const key of Object.keys(report))
      assert.ok(allowed.has(key), `unpublished key ${key}`);
    for (const key of ["addresses", "description", "scamCategory"])
      assert.ok(key in report, `missing ${key}`);
    assert.equal(report.scamCategory, "PHISHING"); // one of the published scamCategory values
    assert.equal(typeof report.description, "string");
    for (const a of report.addresses as Record<string, unknown>[]) {
      // Each address item is either { chain, address } or { domain }, with an optional label.
      const shape =
        "domain" in a ? ["domain", "label"] : ["address", "chain", "label"];
      assert.deepEqual(Object.keys(a).sort(), shape.sort());
      if ("chain" in a) assert.equal(a.chain, "SOL"); // a published ChainKind value
    }
    for (const e of report.evidences as Record<string, unknown>[]) {
      assert.deepEqual(Object.keys(e), ["source"]);
      assert.equal(typeof e.source, "string");
    }
  }
});

test("report data cannot add markdown: inline markers are escaped and line breaks folded", () => {
  assert.equal(
    escapeMarkdown("[click](https://evil.example) *now* _x_ ~y~ `z` \\"),
    "\\[click\\]\\(https://evil.example\\) \\*now\\* \\_x\\_ \\~y\\~ \\`z\\` \\\\",
  );
  assert.equal(
    escapeMarkdown("line one\n### heading\r\nline"),
    "line one ### heading line",
  );
});

test("only an escalated case with a domain or a recipient builds a request", () => {
  const db = openDatabase(":memory:");
  const view = {
    id: 9,
    status: "held" as const,
    decidedBy: null,
    domain: null,
    programIds: [],
    recipients: [],
    sightings: 1,
    inputs: { drainPattern: true, independentDevices: 1, domainListed: false },
    createdAt: 1,
    updatedAt: 1,
  };
  const none: StoredBundle[] = [];
  assert.throws(() => buildChainabuseRequest(view, none), {
    message: "it is held, not escalated",
  });
  assert.throws(() => buildChainabuseRequest(view, none), NothingToReport);
  assert.throws(
    () => buildChainabuseRequest({ ...view, status: "escalated" }, none),
    NothingToReport,
  );
  assert.throws(
    () => buildChainabuseRequest({ ...view, status: "escalated" }, none),
    { message: "it has no domain or recipient to report" },
  );
  assert.equal(loadCase(db, 1, bundledLists()), null);
});

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const RFC_KEYPAIR = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];

test("with the flag on and no domain lists, the API still starts, serves /health and answers 503 on the triage routes", async () => {
  // A copy of the API with no fixtures folder beside it, so the bundled lists cannot load. The
  // real path, since the temporary directory can sit behind a symlink (as /var does on macOS).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-e13-no-lists-")));
  const api = join(dir, "services", "api");
  cpSync(fileURLToPath(new URL("..", import.meta.url)), api, {
    recursive: true,
    filter: (src) => !src.includes(`${sep}node_modules`),
  });
  assert.equal(existsSync(join(dir, "fixtures")), false);
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  const child = spawn(process.execPath, [join(api, "src", "index.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      ORGANIZER_KEYPAIR_PATH: keyPath,
      DATABASE_PATH: join(dir, "limen.db"),
      // E-02 refuses API_PORT=0, so the test names a port that was free a moment ago.
      API_PORT: String(await freePort()),
      CHAINABUSE_POST: "dry-run",
      STATION_DISPLAY_TOKEN: TEST_STATION_DISPLAY_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const match =
          /^limen api 0\.1\.0 listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(
            out,
          );
        if (match?.[1]) resolve(match[1]);
      });
      child.once("exit", (code) =>
        reject(new Error(`API exited early with code ${code}: ${stderr}`)),
      );
    });
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      version: "0.1.0",
      schema_version: 3,
    });
    const report = await fetch(`${url}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(DEVICE_1),
    });
    assert.equal(report.status, 503);
    assert.deepEqual(await report.json(), {
      error: "triage_lists_unavailable",
    });
    assert.equal(
      stderr,
      "limen api: the triage domain lists did not load, so the triage routes answer 503.\n",
    );
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Addresses for a summary in E-09's shape: SHA-256 of a fixed label in base58, as in the E-10
// fixtures, so none belongs to anyone on any network.
const TOKEN_ACCOUNT = "DJZWkGHFsPLN9y2i2ajWnyBQhbVqbyq1DE4nQtCQyiAz"; // "limen e13 fixture token account"
const MINT = "5KnAgeXC6j5jyKEERx9SvMQLsR7rat4KwweTqf1eRA6T"; // "limen e13 fixture mint"
const CO_SIGNER = "GKykEcgDPAt2kyCnSKReJV5dWwPhgqym3xZfszLEnjxN"; // "limen e13 fixture co-signer"

test("summary values naming an address other than a recipient or program ID are left out, wherever they sit", () => {
  const listed = new Set([RECIPIENT, SYSTEM_PROGRAM]);
  assert.deepEqual(
    redactSummary(
      {
        note: `sends to ${RECIPIENT} through ${SYSTEM_PROGRAM}`,
        joined: `x${RECIPIENT}`,
        [TOKEN_ACCOUNT]: { lamports: "1" },
        list: [RECIPIENT, MINT, 7, null],
        nested: { to: { address: CO_SIGNER }, kind: "sol-out" },
      },
      listed,
    ),
    {
      summary: {
        note: `sends to ${RECIPIENT} through ${SYSTEM_PROGRAM}`,
        list: [RECIPIENT, 7, null],
        nested: { to: {}, kind: "sol-out" },
      },
      leftOut: 4,
    },
  );
});

test('signers.feePayer is kept only as the role marker "user"', () => {
  const listed = new Set<string>();
  assert.deepEqual(
    redactSummary({ signers: { feePayer: "user", unsigned: true } }, listed),
    { summary: { signers: { feePayer: "user", unsigned: true } }, leftOut: 0 },
  );
  // A shortened address names no full base58 run, so only the fee payer rule leaves it out.
  assert.deepEqual(
    redactSummary(
      { signers: { feePayer: "4FLJ...APRa", unsigned: true } },
      listed,
    ),
    { summary: { signers: { unsigned: true } }, leftOut: 1 },
  );
});

/** A summary in E-09's shape (packages/preflight/src/summary.ts) whose fee payer is a wallet, not the role marker. */
function e09Summary(feePayer: string, lamports: string) {
  return {
    effects: [
      {
        kind: "sol-out",
        instruction: 0,
        to: { address: RECIPIENT },
        lamports,
        reason: "transfer",
      },
      {
        kind: "token-out",
        instruction: 1,
        program: "token",
        source: { address: TOKEN_ACCOUNT },
        destination: { address: RECIPIENT },
        mint: { address: MINT },
        amount: "250000000",
        decimals: 6,
      },
    ],
    others: [],
    undecoded: [],
    signers: {
      feePayer,
      others: [{ address: CO_SIGNER, signed: false }],
      unsigned: true,
    },
    unresolvedAccounts: 0,
  };
}

test("a stored summary whose fee payer is the reporter's wallet gives a body without it, opted in or not", async () => {
  const reports = [DEVICE_1, DEVICE_2].map((r, i) => ({
    ...r,
    summary: e09Summary(String(r.wallet), `150000000${i + 1}`),
  }));
  const KEPT =
    `{"effects":[{"instruction":0,"kind":"sol-out","lamports":"1500000001","reason":"transfer","to":{"address":"${RECIPIENT}"}},` +
    `{"amount":"250000000","decimals":6,"destination":{"address":"${RECIPIENT}"},"instruction":1,"kind":"token-out","mint":{},"program":"token","source":{}}],` +
    `"others":[],"signers":{"others":[{"signed":false}],"unsigned":true},"undecoded":[],"unresolvedAccounts":0}`;
  const owed = [
    {
      ...OWED_BODY[0]!,
      description: [
        "### limen escalation: drain pattern",
        "",
        BOTH_SOURCES,
        "",
        "- Case: 1",
        THRESHOLD_LINE,
        "- Sightings: 2, from 2 distinct reported install IDs",
        "- Domain: claim-pass.example",
        "- Domain on the bundled fixture list: no",
        "- Re-simulation reproduced the reported summary with a drain pattern: yes",
        "- Summary values left out, so that no address beyond the recipients and programs below is reported: 4",
        "",
        "#### Simulated transaction summary",
        `- effects: \\[{"instruction":0,"kind":"sol-out","lamports":"1500000001","reason":"transfer","to":{"address":"${RECIPIENT}"}},{"amount":"250000000","decimals":6,"destination":{"address":"${RECIPIENT}"},"instruction":1,"kind":"token-out","mint":{},"program":"token","source":{}}\\]`,
        "- others: \\[\\]",
        '- signers: {"others":\\[{"signed":false}\\],"unsigned":true}',
        "- undecoded: \\[\\]",
        "- unresolvedAccounts: 0",
        "",
        "#### Programs",
        `- ${SYSTEM_PROGRAM}`,
        "",
        "#### Recipients as reported to limen",
        `- ${RECIPIENT}`,
      ].join("\n"),
      evidences: [
        {
          source: `limen simulated transaction summary (Solana devnet): ${KEPT}`,
        },
      ],
    },
  ];
  for (const include_wallet of [false, true]) {
    const { logged, statuses } = await runFlow(
      "dry-run",
      include_wallet,
      reports,
    );
    assert.deepEqual(
      statuses.map((s) => (s as { case_status: string }).case_status),
      ["held", "escalated"],
    );
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.split("\n")[1], JSON.stringify(owed));
    for (const address of [
      String(DEVICE_1.wallet),
      String(DEVICE_2.wallet),
      TOKEN_ACCOUNT,
      MINT,
      CO_SIGNER,
    ])
      assert.ok(!logged[0]!.includes(address), `${address} reached the body`);
  }
});

test("an escalated case with no domain and no recipient logs why nothing was built", async () => {
  const reports = [DEVICE_1, DEVICE_2].map((r) => ({
    ...r,
    url: null,
    recipients: [],
  }));
  const { logged, outbound, statuses } = await runFlow(
    "dry-run",
    false,
    reports,
  );
  assert.deepEqual(
    statuses.map((s) => (s as { case_status: string }).case_status),
    ["held", "escalated"],
  );
  assert.deepEqual(logged, [
    "chainabuse dry run, nothing built for case 1: it has no domain or recipient to report",
  ]);
  assert.deepEqual(outbound, []);
});

test("the hook logs one body per case, and a line saying why for every call that builds none", async () => {
  const { db } = await runFlow("off");
  const logged: string[] = [];
  const hook = chainabuseHook("dry-run", db, bundledLists(), (line) =>
    logged.push(line),
  )!;
  hook(1);
  hook(1);
  hook(99);
  assert.equal(logged.length, 3);
  assert.equal(logged[0]!.split("\n")[1], JSON.stringify(OWED_BODY));
  assert.deepEqual(logged.slice(1), [
    "chainabuse dry run, nothing built for case 1: its request was already logged once since the service started",
    "chainabuse dry run, nothing built for case 99: there is no such case",
  ]);
  // A failure that is not a refusal is logged without its message, which could quote the summary.
  db.prepare(
    "UPDATE evidence_bundles SET summary_json = ? WHERE sighting_id = 1",
  ).run(`{"feePayer":"${String(DEVICE_1.wallet)}"`);
  const fresh: string[] = [];
  chainabuseHook("dry-run", db, bundledLists(), (line) => fresh.push(line))!(1);
  assert.deepEqual(fresh, [
    "chainabuse dry run, nothing built for case 1: the request could not be built",
  ]);
});

/** The opening sentence of the one body logged for `reports`, with each re-simulated as reported. */
async function openingFor(reports: readonly Record<string, unknown>[]) {
  const { logged, statuses } = await runFlow("dry-run", false, reports);
  assert.deepEqual(
    statuses.map((s) => (s as { case_status: string }).case_status),
    ["held", "escalated"],
  );
  assert.equal(logged.length, 1);
  const body = JSON.parse(logged[0]!.split("\n")[1]!) as {
    description: string;
  }[];
  return body[0]!.description.split("\n")[2];
}

test("the opening names the decoded instructions alone when the report's simulation did not run without an error", async () => {
  const withSimulation = (simulation: unknown) =>
    [DEVICE_1, DEVICE_2].map((r) => ({
      ...r,
      summary: { ...(r.summary as object), simulation },
    }));
  // As in the review's C1: an approval whose recorded simulation failed.
  assert.equal(
    await openingFor(
      withSimulation({
        status: "ran",
        err: { InstructionError: [0, "InvalidAccountData"] },
        changes: [],
      }),
    ),
    DECODED_ONLY,
  );
  assert.equal(
    await openingFor(
      withSimulation({ status: "not-run", reason: "rpc_unreachable" }),
    ),
    DECODED_ONLY,
  );
  assert.equal(
    await openingFor(withSimulation({ status: "ran", err: null, changes: [] })),
    BOTH_SOURCES,
  );
  // The fixture report records no simulation, so either source may have fired.
  assert.equal(await openingFor([DEVICE_1, DEVICE_2]), BOTH_SOURCES);
});

test("the body counts reported install IDs and names the list it checked, not more", async () => {
  // As in the review's C2: one client posts the same report under two invented install IDs.
  const { logged } = await runFlow("dry-run", false, [
    { ...DEVICE_1, device_id: "invented-install-id-0001" },
    { ...DEVICE_1, device_id: "invented-install-id-0002" },
  ]);
  const text = logged.join("\n");
  assert.match(text, /- Sightings: 2, from 2 distinct reported install IDs/);
  assert.ok(!/independent|devices?\b/.test(text));
  assert.ok(!/Phantom|PhishDestroy/.test(text));
});

test("a domain on the bundled fixture list is described as on that list, not on Phantom's or PhishDestroy's", async () => {
  // As in the review's C3: one device, a drain pattern, and a URL on a fixture-list domain.
  const { logged, statuses } = await runFlow("dry-run", false, [
    { ...DEVICE_1, url: "https://listed-on-phantom.example/api/tx" },
  ]);
  assert.deepEqual(
    statuses.map((s) => (s as { case_status: string }).case_status),
    ["escalated"],
  );
  const description = (
    JSON.parse(logged[0]!.split("\n")[1]!) as { description: string }[]
  )[0]!.description.split("\n");
  assert.deepEqual(description.slice(4, 9), [
    "- Case: 1",
    THRESHOLD_LINE,
    "- Sightings: 1, from 1 distinct reported install ID",
    "- Domain: listed-on-phantom.example",
    "- Domain on the bundled fixture list: yes",
  ]);
});

test("a feePayer at any depth is kept only as the role marker, so E-09's full report is covered too", () => {
  const listed = new Set([RECIPIENT, SYSTEM_PROGRAM]);
  assert.deepEqual(
    redactSummary(
      {
        kind: "ready",
        feePayerSet: true,
        summary: { signers: { feePayer: "4FLJ...APRa", unsigned: true } },
        blocks: [{ feePayer: "user" }, { feePayer: "wallet-4FLJ" }],
      },
      listed,
    ),
    {
      summary: {
        kind: "ready",
        feePayerSet: true,
        summary: { signers: { unsigned: true } },
        blocks: [{ feePayer: "user" }, {}],
      },
      leftOut: 2,
    },
  );
});

test("a stored full report in E-09's shape gives a body without the fee payer or the wallet's simulated account", async () => {
  // E-09's PreflightReport (packages/preflight/src/preflight.ts): the summary nested under
  // `summary`, with the fee payer at summary.signers.feePayer, here in a shortened form no
  // base58 rule can see, and the wallet as the account of a simulated SOL change.
  const shortened = (w: string) => `${w.slice(0, 4)}...${w.slice(-4)}`;
  const reports = [DEVICE_1, DEVICE_2].map((r, i) => ({
    ...r,
    summary: {
      kind: "ready",
      feePayerSet: false,
      summary: e09Summary(shortened(String(r.wallet)), `150000000${i + 1}`),
      simulation: {
        status: "ran",
        err: null,
        changes: [
          {
            kind: "sol",
            account: String(r.wallet),
            before: "2000000000",
            after: "499999999",
            ownerBefore: SYSTEM_PROGRAM,
            ownerAfter: SYSTEM_PROGRAM,
            dataLengthBefore: 0,
            dataLengthAfter: 0,
          },
        ],
      },
      blocks: [],
    },
  }));
  const SIMULATION = `{"changes":[{"after":"499999999","before":"2000000000","dataLengthAfter":0,"dataLengthBefore":0,"kind":"sol","ownerAfter":"${SYSTEM_PROGRAM}","ownerBefore":"${SYSTEM_PROGRAM}"}],"err":null,"status":"ran"}`;
  const SUMMARY =
    `{"effects":[{"instruction":0,"kind":"sol-out","lamports":"1500000001","reason":"transfer","to":{"address":"${RECIPIENT}"}},` +
    `{"amount":"250000000","decimals":6,"destination":{"address":"${RECIPIENT}"},"instruction":1,"kind":"token-out","mint":{},"program":"token","source":{}}],` +
    `"others":[],"signers":{"others":[{"signed":false}],"unsigned":true},"undecoded":[],"unresolvedAccounts":0}`;
  const escaped = (json: string) => json.replace(/[[\]]/g, (c) => `\\${c}`);
  const owed = [
    {
      ...OWED_BODY[0]!,
      description: [
        "### limen escalation: drain pattern",
        "",
        BOTH_SOURCES,
        "",
        "- Case: 1",
        THRESHOLD_LINE,
        "- Sightings: 2, from 2 distinct reported install IDs",
        "- Domain: claim-pass.example",
        "- Domain on the bundled fixture list: no",
        "- Re-simulation reproduced the reported summary with a drain pattern: yes",
        "- Summary values left out, so that no address beyond the recipients and programs below is reported: 5",
        "",
        "#### Simulated transaction summary",
        "- blocks: \\[\\]",
        "- feePayerSet: false",
        "- kind: ready",
        `- simulation: ${escaped(SIMULATION)}`,
        `- summary: ${escaped(SUMMARY)}`,
        "",
        "#### Programs",
        `- ${SYSTEM_PROGRAM}`,
        "",
        "#### Recipients as reported to limen",
        `- ${RECIPIENT}`,
      ].join("\n"),
      evidences: [
        {
          source: `limen simulated transaction summary (Solana devnet): {"blocks":[],"feePayerSet":false,"kind":"ready","simulation":${SIMULATION},"summary":${SUMMARY}}`,
        },
      ],
    },
  ];
  const { logged, statuses } = await runFlow("dry-run", false, reports);
  assert.deepEqual(
    statuses.map((s) => (s as { case_status: string }).case_status),
    ["held", "escalated"],
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.split("\n")[1], JSON.stringify(owed));
  for (const r of [DEVICE_1, DEVICE_2]) {
    const w = String(r.wallet);
    for (const form of [w, shortened(w)])
      assert.ok(!logged[0]!.includes(form), `${form} reached the body`);
  }
});

// Owner ruling 6a: manual escalation is part of E-13, so a human's escalation on the dashboard
// (E-12) also builds the dry-run body.
const TRIAGE_TOKEN = "test-triage-token-0123456789abcdef";

/**
 * Posts the first fixture report (one device, so the case holds under D-05), then takes each
 * dashboard action on case 1. The re-simulation returns `resimulated`.
 */
async function manualFlow(
  mode: ChainabuseMode,
  actions: readonly ("escalate" | "dismiss")[] = ["escalate", "escalate"],
  resimulated: { summary: unknown; drainPattern: boolean } = {
    summary: DEVICE_1.summary,
    drainPattern: true,
  },
) {
  const db = openDatabase(":memory:");
  const logged: string[] = [];
  const server: Server = createApiServer({
    db,
    version: API_VERSION,
    ...TEST_STATION_SETTINGS,
    reports: {
      now: () => 1_795_000_500,
      triageToken: TRIAGE_TOKEN,
      resimulator: async () => resimulated,
      onEscalated: chainabuseHook(mode, db, bundledLists(), (line) =>
        logged.push(line),
      ),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const watch = watchOutbound();
  const steps: unknown[] = [];
  try {
    // One device: the case holds under D-05.
    const report = await fetch(`${base}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(DEVICE_1),
    });
    steps.push(((await report.json()) as { case_status: string }).case_status);
    for (const action of actions) {
      const decided = await fetch(`${base}/cases/1/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TRIAGE_TOKEN}` },
      });
      steps.push(((await decided.json()) as { outcome: string }).outcome);
    }
  } finally {
    watch.restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { logged, outbound: watch.outbound, steps };
}

test("a human's escalation on the dashboard logs the exact dry-run body once", async () => {
  const { logged, outbound, steps } = await manualFlow("dry-run");
  assert.deepEqual(steps, ["held", "decided", "unchanged"]);
  assert.equal(
    logged.length,
    1,
    "one entry, for the escalation that changed the case",
  );
  const owed = [
    {
      ...OWED_BODY[0],
      description: OWED_BODY[0]!.description
        .replace(THRESHOLD_LINE, "- Decided by: human review")
        .replace(
          "- Sightings: 2, from 2 distinct reported install IDs",
          "- Sightings: 1, from 1 distinct reported install ID",
        ),
    },
  ];
  assert.equal(
    logged[0],
    `chainabuse dry run, not sent: POST ${CHAINABUSE_REPORTS_URL}\n${JSON.stringify(owed)}`,
  );
  assert.deepEqual(outbound, []);
});

test("with the flag off, a human's escalation logs and sends nothing", async () => {
  const { logged, outbound, steps } = await manualFlow("off");
  assert.deepEqual(steps, ["held", "decided", "unchanged"]);
  assert.deepEqual(logged, []);
  assert.deepEqual(outbound, []);
});

test("escalate, dismiss, escalate logs one body for the case", async () => {
  const { logged, outbound, steps } = await manualFlow("dry-run", [
    "escalate",
    "dismiss",
    "escalate",
  ]);
  assert.deepEqual(steps, ["held", "decided", "decided", "decided"]);
  assert.equal(logged.length, 2);
  assert.match(logged[0]!, /^chainabuse dry run, not sent: POST /);
  assert.equal(
    logged[1],
    "chainabuse dry run, nothing built for case 1: its request was already logged once since the service started",
  );
  assert.deepEqual(outbound, []);
});

test("a human's escalation without a reproduced drain does not describe one", async () => {
  // The re-simulation gives a different summary and no drain, so nothing is reproduced.
  const { logged } = await manualFlow("dry-run", ["escalate"], {
    summary: { kind: "transaction", effects: [] },
    drainPattern: false,
  });
  assert.equal(logged.length, 1);
  const owed = [
    {
      ...OWED_BODY[0]!,
      description: [
        "### limen escalation: no drain pattern reproduced",
        "",
        "A QR reported through limen was escalated, but no re-simulation on limen's server reproduced a drain pattern for it. The summary below is the one the reporter's app showed. limen simulates on Solana devnet only.",
        "",
        "- Case: 1",
        "- Decided by: human review",
        "- Sightings: 1, from 1 distinct reported install ID",
        "- Domain: claim-pass.example",
        "- Domain on the bundled fixture list: no",
        "- Re-simulation reproduced the reported summary with a drain pattern: no",
        "",
        "#### Simulated transaction summary",
        `- effects: \\[{"lamports":"1500000001","to":"${RECIPIENT}","type":"sol\\_out"}\\]`,
        "- kind: transaction",
        "",
        "#### Programs",
        `- ${SYSTEM_PROGRAM}`,
        "",
        "#### Recipients as reported to limen",
        `- ${RECIPIENT}`,
      ].join("\n"),
    },
  ];
  assert.equal(logged[0]!.split("\n")[1], JSON.stringify(owed));
  assert.ok(!logged[0]!.includes("### limen escalation: drain pattern"));
});
