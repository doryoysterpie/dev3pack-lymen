// E-10, app side: the report bundle for the E-09 fixture drainer owes this exact JSON.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  COMPUTE_BUDGET_PROGRAM,
  DEVNET_GENESIS_HASH,
  MEMO_PROGRAM,
  preflight,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  toReport,
  type Fetch,
  type RpcEndpoint,
} from "@limen/preflight";

import { buildReport, type ReadyPreflight } from "./bundle.ts";

interface FixtureCase {
  readonly name: string;
  readonly transaction: string;
  readonly owed: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Record<string, string>;
  readonly cases: readonly FixtureCase[];
};

function caseNamed(start: string): FixtureCase {
  const found = fixture.cases.find((c) => c.name.startsWith(start));
  assert.ok(found, `no fixture case starts with ${start}`);
  return found;
}

// No network: the pre-flight decodes and marks the simulation not run.
const offlineFetch: Fetch = async () => {
  throw new Error("offline");
};
const offlineEndpoint: RpcEndpoint = {
  url: "https://devnet.example",
  fetch: offlineFetch,
};

async function ready(
  base64: string,
  endpoint: RpcEndpoint = offlineEndpoint,
): Promise<ReadyPreflight> {
  const result = await preflight(endpoint, base64, fixture.user);
  assert.equal(result.kind, "ready");
  return result as ReadyPreflight;
}

const QR = "solana:https%3A%2F%2Fclaim-pass.example%2Fapi%2Ftx";
const LINK = "https://claim-pass.example/api/tx";
const DRAINER = caseNamed("drainer: SOL balance out");

const base = {
  qrText: QR,
  link: LINK,
  user: fixture.user,
  deviceId: "fixture-device-01-0123456789",
  timestamp: 1_795_000_001,
  appVersion: "0.0.0",
};

describe("E-10 app side: the report bundle for the fixture drainer", () => {
  it("is the owed JSON, with no wallet and unmarked recipients from preflight", async () => {
    const preflightResult = await ready(DRAINER.transaction);
    const bundle = buildReport({
      ...base,
      preflight: preflightResult,
      includeWallet: false,
    });
    // Owed values: summary is the role-marked report JSON from toReport,
    // while program_ids and recipients come from preflight's in-memory unmarked
    // lists (bundleLists), never from the report JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(bundle)), {
      device_id: "fixture-device-01-0123456789",
      payload: QR,
      url: LINK,
      transaction: DRAINER.transaction,
      simulation: null,
      summary: {
        kind: "ready",
        feePayerSet: false,
        summary: {
          effects: [
            {
              kind: "priority-fee",
              instruction: 0,
              microLamportsPerUnit: "50000",
              unitLimit: null,
              lamports: "70000",
            },
            {
              kind: "sol-out",
              instruction: 2,
              to: { address: "account 1" },
              lamports: "4990000000",
              reason: "transfer",
            },
            {
              kind: "delegate-approved",
              instruction: 3,
              program: "token",
              account: { address: "account 2" },
              delegate: { address: "account 1" },
              mint: null,
              amount: "18446744073709551615",
              decimals: null,
            },
          ],
          others: [{ instruction: 1, kind: "memo" }],
          undecoded: [],
          signers: {
            feePayer: "user",
            others: [],
            unsigned: true,
          },
          unresolvedAccounts: 0,
        },
        simulation: {
          status: "not-run",
          reason: "getGenesisHash: the endpoint could not be reached",
        },
        blocks: ["simulation-not-run"],
      },
      program_ids: [
        COMPUTE_BUDGET_PROGRAM,
        MEMO_PROGRAM,
        SYSTEM_PROGRAM,
        TOKEN_PROGRAM,
      ],
      recipients: [fixture.keys.attacker],
      timestamp: 1_795_000_001,
      app_version: "0.0.0",
    });
    assert.equal(
      fixture.keys.attacker,
      "AadqUhBH5BtWcKCxnz9gfrWFCDBRXcdHQwzEsTqK49cK",
    );
    assert.equal(bundle.recipients.includes(fixture.keys.attacker), true);
    // The wallet's address appears nowhere in the bundle JSON or report JSON;
    // the report JSON carries neither the wallet nor the attacker address.
    assert.equal(JSON.stringify(bundle).includes(fixture.user), false);
    const reportJson = JSON.stringify(bundle.summary);
    assert.equal(reportJson.includes(fixture.user), false);
    assert.equal(reportJson.includes(fixture.keys.attacker), false);
  });

  it("carries the wallet only when the reporter opts in", async () => {
    const bundle = buildReport({
      ...base,
      preflight: await ready(DRAINER.transaction),
      includeWallet: true,
    });
    assert.equal(bundle.include_wallet, true);
    assert.equal(bundle.wallet, fixture.user);
  });

  it("has exactly the fields the API's POST /reports accepts", async () => {
    const bundle = buildReport({
      ...base,
      preflight: await ready(DRAINER.transaction),
      includeWallet: true,
    });
    // The field list in services/api/src/evidence.ts on E-10.
    const accepted = [
      "app_version",
      "device_id",
      "include_wallet",
      "payload",
      "program_ids",
      "recipients",
      "simulation",
      "summary",
      "timestamp",
      "transaction",
      "url",
      "wallet",
    ];
    assert.deepEqual(Object.keys(bundle).sort(), accepted);
  });

  it("leaves out a recipient whose address sits in a lookup table that was not loaded", async () => {
    const unloaded = caseNamed(
      "drainer as a v0 transaction, lookup table not loaded",
    );
    const preflightResult = await ready(unloaded.transaction);
    const bundle = buildReport({
      ...base,
      preflight: preflightResult,
      includeWallet: false,
    });
    assert.deepEqual(bundle.recipients, []);
    assert.deepEqual(bundle.summary, toReport(preflightResult));
  });

  it("keeps unmarked program_ids and recipients even when toReport marks them", async () => {
    const unknown = caseNamed(
      "unknown program: fallback, with the decodable transfer still shown",
    );
    const preflightResult = await ready(unknown.transaction);
    const bundle = buildReport({
      ...base,
      preflight: preflightResult,
      includeWallet: false,
    });
    assert.deepEqual(bundle.program_ids, [
      SYSTEM_PROGRAM,
      fixture.keys.unknownProgram,
    ]);
    assert.deepEqual(bundle.recipients, [fixture.keys.organizer]);
    const reportJson = JSON.stringify(bundle.summary);
    assert.equal(reportJson.includes(fixture.user), false);
    assert.equal(reportJson.includes(fixture.keys.unknownProgram), false);
    assert.equal(reportJson.includes(fixture.keys.organizer), false);
  });

  it("keeps the simulation slot and blockhash from a JSON-RPC endpoint run, with no wallet in report JSON", async () => {
    const slot = 350_000_001;
    const blockhash = fixture.keys.mint;
    const rpcFetch: Fetch = async (url, init) => {
      const request = JSON.parse(init.body) as { id: number; method: string };
      const result =
        request.method === "getGenesisHash"
          ? DEVNET_GENESIS_HASH
          : {
              context: { slot },
              value: {
                err: null,
                replacementBlockhash: { blockhash, lastValidBlockHeight: 1 },
                preBalances: [5_000_000_000, 0, 0, 1, 1, 1, 1],
                postBalances: [10_000_000, 4_990_000_000, 0, 1, 1, 1, 1],
                loadedAddresses: { writable: [], readonly: [] },
              },
            };
      return {
        ok: true,
        status: 200,
        url,
        text: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      };
    };
    const preflightResult = await ready(DRAINER.transaction, {
      url: "https://devnet.example",
      fetch: rpcFetch,
    });
    const bundle = buildReport({
      ...base,
      preflight: preflightResult,
      includeWallet: false,
    });
    assert.deepEqual(bundle.simulation, { slot, blockhash });
    assert.deepEqual(bundle.recipients, [fixture.keys.attacker]);
    assert.equal(JSON.stringify(bundle).includes(fixture.user), false);
    assert.equal(JSON.stringify(bundle.summary).includes(fixture.user), false);
  });
});
