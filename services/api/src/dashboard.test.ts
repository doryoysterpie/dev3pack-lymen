// E-12: the dashboard routes, end to end over HTTP, including the done test: a dismissed case
// does not re-open on a third sighting.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createContext, runInContext } from "node:vm";

import { openDatabase } from "./db.ts";
import { DASHBOARD_CSP } from "./dashboard.ts";
import type { Resimulator } from "./evidence.ts";
import { API_VERSION, createApiServer } from "./server.ts";

const FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/reports/e10-reports.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

const TOKEN = "test-triage-token-0123456789-abcdefghij";
const servers: Server[] = [];

after(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

/**
 * A re-simulator standing in for a recorded RPC response: for a fixture transaction it returns
 * that fixture's summary, with the drain pattern the test sets.
 */
function recorded(state: { drain: boolean }): Resimulator {
  const summaries = new Map(
    Object.values(FIXTURES)
      .filter((f) => typeof f.transaction === "string")
      .map((f) => [f.transaction as string, f.summary]),
  );
  return async (tx) => {
    const summary = summaries.get(Buffer.from(tx).toString("base64"));
    if (summary === undefined)
      throw new Error("no recorded response for these bytes");
    return { summary, drainPattern: state.drain };
  };
}

async function start(options: {
  triageToken?: string;
  resimulator?: Resimulator;
  lists?: null;
}): Promise<string> {
  let clock = 1_795_200_000;
  const server = createApiServer({
    db: openDatabase(":memory:"),
    version: API_VERSION,
    reports: { now: () => clock++, ...options },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function report(
  base: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await fetch(`${base}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...FIXTURES[name], ...overrides }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { case_id: number; case_status: string };
}

const THIRD_DEVICE = { device_id: "fixture-device-03-0123456789" };

test("E-12 done test, end to end: a dismissed case does not re-open on a third sighting", async () => {
  const state = { drain: false };
  const base = await start({
    triageToken: TOKEN,
    resimulator: recorded(state),
  });
  // Two sightings from two devices whose re-simulations show no drain pattern: the case holds.
  assert.equal((await report(base, "drainer_device_1")).case_status, "held");
  assert.equal((await report(base, "drainer_device_2")).case_status, "held");

  const dismissed = await fetch(`${base}/cases/1/dismiss`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(dismissed.status, 200);
  const decision = (await dismissed.json()) as {
    outcome: string;
    case: Record<string, unknown>;
  };
  assert.equal(decision.outcome, "decided");
  assert.equal(decision.case.status, "dismissed");
  assert.equal(decision.case.decided_by, "human");

  // The third sighting is from a third device and its re-simulation shows a drain pattern, so
  // the case now meets the D-05 threshold. It stays dismissed.
  state.drain = true;
  const third = await report(base, "drainer_device_2", THIRD_DEVICE);
  assert.deepEqual(third, { ...third, case_id: 1, case_status: "dismissed" });

  const view = (await (
    await fetch(`${base}/cases/1`, { headers: auth })
  ).json()) as {
    case: Record<string, unknown>;
    evidence: Record<string, unknown>[];
  };
  assert.equal(view.case.status, "dismissed");
  assert.equal(view.case.decided_by, "human");
  assert.equal(view.case.sightings, 3);
  assert.equal(view.case.independent_devices, 3);
  assert.equal(view.case.drain_pattern, true);
  assert.deepEqual(
    view.evidence.map((e) => e.sighting_id),
    [1, 2, 3],
  );
});

test("control for the done test: without the dismissal, the same third sighting escalates the case", async () => {
  const state = { drain: false };
  const base = await start({
    triageToken: TOKEN,
    resimulator: recorded(state),
  });
  await report(base, "drainer_device_1");
  await report(base, "drainer_device_2");
  state.drain = true;
  assert.equal(
    (await report(base, "drainer_device_2", THIRD_DEVICE)).case_status,
    "escalated",
  );
});

test("the evidence view shows each bundle as stored, with no wallet field when the report sent none", async () => {
  const base = await start({ triageToken: TOKEN });
  await report(base, "drainer_device_1");
  const res = await fetch(`${base}/cases/1`, { headers: auth });
  assert.equal(res.status, 200);
  const { evidence } = (await res.json()) as {
    evidence: Record<string, unknown>[];
  };
  assert.equal(evidence.length, 1);
  const [e] = evidence;
  assert.equal(e.transaction, FIXTURES.drainer_device_1.transaction);
  assert.deepEqual(e.summary, FIXTURES.drainer_device_1.summary);
  assert.equal(e.url, "https://claim-pass.example/api/tx");
  assert.equal(e.wallet, null);
  assert.equal(e.resimulation, null);
  assert.equal(
    e.device_hash,
    "56f1fa47c2de2c2ddd99c6fbe9c5942ac90ab0b01984171ace2508c15bcc306e",
  );
});

test("a human can escalate a held case from the dashboard routes; a repeat is unchanged", async () => {
  const base = await start({ triageToken: TOKEN });
  await report(base, "drainer_device_1");
  const first = await fetch(`${base}/cases/1/escalate`, {
    method: "POST",
    headers: auth,
  });
  const firstBody = (await first.json()) as {
    outcome: string;
    case: Record<string, unknown>;
  };
  assert.deepEqual(
    [
      first.status,
      firstBody.outcome,
      firstBody.case.status,
      firstBody.case.decided_by,
    ],
    [200, "decided", "escalated", "human"],
  );
  const again = await fetch(`${base}/cases/1/escalate`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(
    ((await again.json()) as { outcome: string }).outcome,
    "unchanged",
  );
  const list = (await (
    await fetch(`${base}/cases`, { headers: auth })
  ).json()) as {
    cases: Record<string, unknown>[];
  };
  assert.deepEqual(
    list.cases.map((c) => [c.id, c.status]),
    [[1, "escalated"]],
  );
});

test("the JSON routes answer 503 with no token set, and 401 without the right bearer token", async () => {
  const unset = await start({});
  const res503 = await fetch(`${unset}/cases`, { headers: auth });
  assert.equal(res503.status, 503);
  assert.deepEqual(await res503.json(), { error: "triage_token_unset" });
  const short = await start({ triageToken: "too-short" });
  assert.equal((await fetch(`${short}/cases`, { headers: auth })).status, 503);

  const base = await start({ triageToken: TOKEN });
  await report(base, "drainer_device_1");
  for (const [path, method] of [
    ["/cases", "GET"],
    ["/cases/1", "GET"],
    ["/cases/1/dismiss", "POST"],
  ]) {
    const refused: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: TOKEN },
    ];
    for (const headers of refused) {
      const res = await fetch(`${base}${path}`, { method, headers });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
    }
  }
  // Nothing was dismissed by the refused requests.
  const view = (await (
    await fetch(`${base}/cases/1`, { headers: auth })
  ).json()) as {
    case: Record<string, unknown>;
  };
  assert.equal(view.case.status, "held");
});

test("an unknown case is 404, and a wrong method is 405 with an Allow header", async () => {
  const base = await start({ triageToken: TOKEN });
  assert.equal((await fetch(`${base}/cases/9`, { headers: auth })).status, 404);
  const missing = await fetch(`${base}/cases/9/dismiss`, {
    method: "POST",
    headers: auth,
  });
  assert.deepEqual(
    [missing.status, await missing.json()],
    [404, { error: "unknown_case" }],
  );
  const wrong = await fetch(`${base}/cases/1/dismiss`, { headers: auth });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "POST");
  assert.equal(
    (await fetch(`${base}/cases/abc`, { headers: auth })).status,
    404,
  );
});

test("the page, script and style are served without a token, with a CSP that allows only this API", async () => {
  const base = await start({});
  const page = await fetch(`${base}/dashboard`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("content-security-policy"), DASHBOARD_CSP);
  assert.match(await page.text(), /<title>limen triage<\/title>/);
  const script = await fetch(`${base}/dashboard.js`);
  assert.equal(
    script.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.match(await script.text(), /textContent/);
  const style = await fetch(`${base}/dashboard.css`);
  assert.equal(style.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(
    (await fetch(`${base}/dashboard`, { method: "POST" })).status,
    405,
  );
});

test("E-19: the header shows the logo with the alt text limen, served from the repository's assets folder", async () => {
  const base = await start({});
  assert.match(
    await (await fetch(`${base}/dashboard`)).text(),
    /<h1><img class="logo" src="\/limen-logo\.svg" alt="limen" \/> triage<\/h1>/,
  );
  const logo = await fetch(`${base}/limen-logo.svg`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/svg+xml");
  assert.deepEqual(
    Buffer.from(await logo.arrayBuffer()),
    readFileSync(new URL("../../../assets/limen-logo.svg", import.meta.url)),
  );
  assert.match(DASHBOARD_CSP, /(^|; )img-src 'self'(;|$)/);
});

test("without the domain lists, /health and the page still answer, and the triage routes answer 503", async () => {
  const base = await start({ triageToken: TOKEN, lists: null });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, "ok");
  assert.equal((await fetch(`${base}/dashboard`)).status, 200);
  const report = await fetch(`${base}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FIXTURES.drainer_device_1),
  });
  assert.deepEqual(
    [report.status, await report.json()],
    [503, { error: "triage_lists_unavailable" }],
  );
  const cases = await fetch(`${base}/cases`, { headers: auth });
  assert.equal(cases.status, 503);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("the page shows a time it cannot format as its number, and never calls a missing wallet field left out", () => {
  const source = readFileSync(
    new URL("../dashboard/dashboard.js", import.meta.url),
    "utf8",
  );
  // The script needs only window at load; time() is a plain function in it.
  const page = createContext({ window: { addEventListener() {} } });
  runInContext(source, page);
  // The owed date for 1795000001 was computed with date -u and Python, not with this code.
  assert.equal(runInContext("time(1795000001)", page), "2026-11-18T11:06:41Z");
  assert.equal(
    runInContext("time(8640000000001)", page),
    "8640000000001 (not a valid time)",
  );
  assert.equal(
    source.includes(
      "Not sent. The transaction bytes still name the signing wallet.",
    ),
    true,
  );
  assert.equal(source.includes("(left out)"), false);
  // The bytes sentence appears only for a bundle that has transaction bytes.
  assert.equal(
    runInContext('walletText({ wallet: null, transaction: "AQ==" })', page),
    "Not sent. The transaction bytes still name the signing wallet.",
  );
  assert.equal(
    runInContext("walletText({ wallet: null, transaction: null })", page),
    "Not sent.",
  );
  assert.equal(
    runInContext(
      'walletText({ wallet: "4FLJyfdzkWbs2yhhpymoZkudtsuJ3S8A8ft81gTWAPRa", transaction: "AQ==" })',
      page,
    ),
    "4FLJyfdzkWbs2yhhpymoZkudtsuJ3S8A8ft81gTWAPRa",
  );
});
