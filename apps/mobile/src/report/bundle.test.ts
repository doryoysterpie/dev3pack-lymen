// E-10, app side: the report bundle for the E-09 fixture drainer owes this exact JSON.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { preflight } from "../tx/preflight.ts";
import type { Fetch } from "../tx/rpc.ts";
import type { TransactionSummary } from "../tx/summary.ts";
import { buildReport, recipients, type ReadyPreflight } from "./bundle.ts";

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
const offline: Fetch = async () => {
  throw new Error("offline");
};

async function ready(base64: string): Promise<ReadyPreflight> {
  const result = await preflight(
    offline,
    "https://devnet.example",
    base64,
    fixture.user,
  );
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
  it("is the owed JSON, with no wallet", async () => {
    const bundle = buildReport({
      ...base,
      preflight: await ready(DRAINER.transaction),
      includeWallet: false,
    });
    // Owed values: the summary is the one the E-09 fixture owes, written from the generator's
    // inputs; the program IDs are the four programs the generator's drainer calls (compute
    // budget, memo, System, SPL Token); the one recipient is the attacker, who gets the SOL
    // and the delegate.
    assert.deepEqual(JSON.parse(JSON.stringify(bundle)), {
      device_id: "fixture-device-01-0123456789",
      payload: QR,
      url: LINK,
      transaction: DRAINER.transaction,
      simulation: null,
      summary: DRAINER.owed,
      program_ids: [
        "11111111111111111111111111111111",
        "ComputeBudget111111111111111111111111111111",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      ],
      recipients: ["AadqUhBH5BtWcKCxnz9gfrWFCDBRXcdHQwzEsTqK49cK"],
      timestamp: 1_795_000_001,
      app_version: "0.0.0",
    });
    assert.equal(
      fixture.keys.attacker,
      "AadqUhBH5BtWcKCxnz9gfrWFCDBRXcdHQwzEsTqK49cK",
    );
    // The wallet's address appears nowhere in the JSON; the base64 transaction bytes still
    // carry it as an account key.
    assert.equal(JSON.stringify(bundle).includes(fixture.user), false);
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
    // The field list in services/api/src/evidence.ts on E-10 (e301325).
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
    const bundle = buildReport({
      ...base,
      preflight: await ready(unloaded.transaction),
      includeWallet: false,
    });
    assert.deepEqual(bundle.recipients, []);
    assert.deepEqual(bundle.summary, unloaded.owed);
  });
});

describe("recipients", () => {
  it("never lists the user's own wallet", () => {
    const summary = {
      effects: [
        {
          kind: "sol-out",
          instruction: 0,
          to: { address: fixture.user },
          lamports: "1",
          reason: "transfer",
        },
        {
          kind: "authority-changed",
          instruction: 1,
          program: "token",
          account: { address: fixture.keys.userTokenAccount },
          authorityType: "AccountOwner",
          newAuthority: fixture.keys.attacker,
        },
      ],
      others: [],
      undecoded: [],
      signers: {
        userSigns: true,
        userPaysFees: true,
        others: [],
        unsigned: true,
      },
      unresolvedAccounts: 0,
    } as unknown as TransactionSummary;
    assert.deepEqual(recipients(summary, fixture.user), [
      fixture.keys.attacker,
    ]);
  });
});
