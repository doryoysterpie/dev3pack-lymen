// E-10, app side: the report client sends the exact owed request and reads each answer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReportBundle } from "./bundle.ts";
import {
  reportsUrl,
  sendReport,
  type ReportFetch,
  type ReportRequest,
} from "./client.ts";

// A bundle stand-in: the client sends whatever bundle it is given, as JSON.
const BUNDLE = {
  device_id: "fixture-device-01-0123456789",
  payload: "solana:https%3A%2F%2Fclaim-pass.example%2Fapi%2Ftx",
} as unknown as ReportBundle;

function answering(status: number, body: unknown) {
  const calls: { url: string; init: ReportRequest }[] = [];
  const fetch: ReportFetch = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  return { fetch, calls };
}

describe("E-10 app side: sending a report", () => {
  it("POSTs the bundle as JSON to /reports and reads the case the server put it in", async () => {
    const { fetch, calls } = answering(201, {
      sighting_id: 3,
      resimulation: "not_run",
      case_id: 2,
      case_status: "held",
    });
    const outcome = await sendReport(fetch, "http://10.0.2.2:8787", BUNDLE);
    assert.deepEqual(calls, [
      {
        url: "http://10.0.2.2:8787/reports",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"device_id":"fixture-device-01-0123456789","payload":"solana:https%3A%2F%2Fclaim-pass.example%2Fapi%2Ftx"}',
        },
      },
    ]);
    assert.deepEqual(outcome, {
      ok: true,
      sightingId: 3,
      caseId: 2,
      caseStatus: "held",
    });
  });

  it("names the field when the server refuses the report", async () => {
    const { fetch } = answering(400, {
      error: "invalid_report",
      field: "recipients",
    });
    assert.deepEqual(await sendReport(fetch, "http://10.0.2.2:8787", BUNDLE), {
      ok: false,
      reason: "The report server refused the report (field recipients).",
    });
  });

  it("says so when the server cannot be reached, or answers something else", async () => {
    const down: ReportFetch = async () => {
      throw new Error("network");
    };
    assert.deepEqual(await sendReport(down, "http://10.0.2.2:8787", BUNDLE), {
      ok: false,
      reason: "The report server could not be reached.",
    });
    const { fetch } = answering(500, { error: "internal" });
    assert.deepEqual(await sendReport(fetch, "http://10.0.2.2:8787", BUNDLE), {
      ok: false,
      reason: "The report server answered 500.",
    });
    const garbled = answering(201, { sighting_id: "3" });
    assert.deepEqual(
      await sendReport(garbled.fetch, "http://10.0.2.2:8787", BUNDLE),
      { ok: false, reason: "The report server's answer could not be read." },
    );
  });

  it("sends nothing to an address that is not http or https", async () => {
    const { fetch, calls } = answering(201, {});
    assert.deepEqual(await sendReport(fetch, "ftp://10.0.2.2/", BUNDLE), {
      ok: false,
      reason: "The report server address is not an http or https URL.",
    });
    assert.equal((await sendReport(fetch, "not a url", BUNDLE)).ok, false);
    assert.deepEqual(calls, []);
  });
});

describe("reportsUrl", () => {
  it("puts /reports under the base path, with or without a trailing slash", () => {
    assert.equal(
      reportsUrl("http://10.0.2.2:8787/"),
      "http://10.0.2.2:8787/reports",
    );
    assert.equal(
      reportsUrl("https://api.example/limen"),
      "https://api.example/limen/reports",
    );
    assert.equal(
      reportsUrl("https://api.example/limen/"),
      "https://api.example/limen/reports",
    );
  });
});
