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
  parseChainabuseMode,
  redactSummary,
  type ChainabuseMode,
} from "./chainabuse.ts";
import { openDatabase } from "./db.ts";
import { canonicalJson, loadBundle, type StoredBundle } from "./evidence.ts";
import { API_VERSION, createApiServer } from "./server.ts";
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

// The body owed for the fixture case, written out from the inputs: case 1, escalated by the
// threshold on two devices and a reproduced drain; the domain of the reported URL; the one
// recipient; the System Program; the first device's summary, shown with its markers escaped.
const SUMMARY_1 = canonicalJson(DEVICE_1.summary);
const OWED_BODY = [
  {
    scamCategory: "PHISHING",
    description: [
      "### limen escalation: simulated drain pattern",
      "",
      "A QR reported through limen leads to a transaction whose simulation shows funds leaving the signer's wallet. limen simulates on Solana devnet only.",
      "",
      "- Case: 1",
      "- Decided by: the automatic threshold (drain pattern, and two or more devices or a listed domain)",
      "- Sightings: 2, from 2 independent devices",
      "- Domain: claim-pass.example",
      "- Domain on the Phantom or PhishDestroy list: no",
      "- Re-simulation reproduced the reported summary with a drain pattern: yes",
      "",
      "#### Simulated transaction summary",
      `- effects: \\[{"lamports":"1500000001","to":"${RECIPIENT}","type":"sol\\_out"}\\]`,
      "- kind: transaction",
      "",
      "#### Programs",
      `- ${SYSTEM_PROGRAM}`,
      "",
      "#### Recipients",
      `- ${RECIPIENT}`,
    ].join("\n"),
    addresses: [
      { domain: "claim-pass.example", label: "Domain of the reported QR link" },
      {
        chain: "SOL",
        address: RECIPIENT,
        label: "Recipient in the simulated transaction",
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
    message: "case 9 is held, not escalated",
  });
  assert.throws(
    () => buildChainabuseRequest({ ...view, status: "escalated" }, none),
    {
      message: "case 9 has no domain or recipient to report",
    },
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
        "### limen escalation: simulated drain pattern",
        "",
        "A QR reported through limen leads to a transaction whose simulation shows funds leaving the signer's wallet. limen simulates on Solana devnet only.",
        "",
        "- Case: 1",
        "- Decided by: the automatic threshold (drain pattern, and two or more devices or a listed domain)",
        "- Sightings: 2, from 2 independent devices",
        "- Domain: claim-pass.example",
        "- Domain on the Phantom or PhishDestroy list: no",
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
        "#### Recipients",
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
