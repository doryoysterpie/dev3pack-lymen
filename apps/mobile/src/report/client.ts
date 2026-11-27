// Sends a report bundle to the limen API's POST /reports (E-10, app side). The fetch is
// passed in, so the exact request is tested in Node. URLs are parsed with the package Expo
// installs as the global URL on the device, as src/qr/classify.ts does.

import { URL } from "whatwg-url-minimum";

import type { ReportBundle } from "./bundle.ts";

export interface ReportRequest {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type ReportFetch = (
  url: string,
  init: ReportRequest,
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export type ReportOutcome =
  | {
      readonly ok: true;
      readonly sightingId: number;
      readonly caseId: number;
      readonly caseStatus: string;
    }
  | { readonly ok: false; readonly reason: string };

/** The reports endpoint under an http or https API base URL, or null for anything else. */
export function reportsUrl(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/reports`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sendReport(
  fetch: ReportFetch,
  apiUrl: string,
  bundle: ReportBundle,
): Promise<ReportOutcome> {
  const url = reportsUrl(apiUrl);
  if (url === null) {
    return {
      ok: false,
      reason: "The report server address is not an http or https URL.",
    };
  }
  let response: Awaited<ReturnType<ReportFetch>>;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
  } catch {
    return { ok: false, reason: "The report server could not be reached." };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 201 && isRecord(body)) {
    const { sighting_id, case_id, case_status } = body;
    if (
      Number.isSafeInteger(sighting_id) &&
      Number.isSafeInteger(case_id) &&
      typeof case_status === "string"
    ) {
      return {
        ok: true,
        sightingId: sighting_id as number,
        caseId: case_id as number,
        caseStatus: case_status,
      };
    }
    return {
      ok: false,
      reason: "The report server's answer could not be read.",
    };
  }
  if (
    response.status === 400 &&
    isRecord(body) &&
    typeof body.field === "string"
  ) {
    return {
      ok: false,
      reason: `The report server refused the report (field ${body.field}).`,
    };
  }
  return {
    ok: false,
    reason: `The report server answered ${response.status}.`,
  };
}
