// Report routes (E-10): POST /reports takes an evidence bundle from the app and stores it as
// a sighting. Later triage units add their routes here.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  parseReport,
  resimulateBundle,
  storeReport,
  type Resimulator,
} from "./evidence.ts";

/** Largest report body accepted, in bytes. A full bundle is a few kilobytes. */
export const MAX_REPORT_BODY_BYTES = 64 * 1024;

export interface ReportOptions {
  /** The current Unix time in whole seconds. Defaults to the system clock. */
  readonly now?: () => number;
  /** Re-simulates stored bundles. Unset until the E-09 package lands; then no re-simulation runs. */
  readonly resimulator?: Resimulator;
  /** How long a re-simulation may take before it counts as failed. Defaults to 15 s. */
  readonly resimulationTimeoutMs?: number;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function postReport(
  db: DatabaseSync,
  options: ReportOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(
      (await readBody(req, MAX_REPORT_BODY_BYTES)).toString("utf8"),
    );
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      sendJson(res, 413, { error: "body_too_large" }, { connection: "close" });
      return;
    }
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const result = parseReport(body, now());
  if (!result.ok) {
    sendJson(res, 400, { error: "invalid_report", field: result.field });
    return;
  }
  // From here the report is stored, so the answer is 201 whatever the re-simulation does: a
  // failed re-simulation is recorded on the bundle and answered as "failed", never as a 500
  // that would make a client retry and file the report twice.
  const sightingId = storeReport(db, result.report, now());
  let resimulation: string = "not_run";
  if (options.resimulator !== undefined) {
    const outcome = await resimulateBundle(
      db,
      sightingId,
      options.resimulator,
      now(),
      options.resimulationTimeoutMs,
    );
    resimulation =
      outcome.status === "resimulated"
        ? outcome.matches
          ? "matches"
          : "differs"
        : outcome.status;
  }
  sendJson(res, 201, { sighting_id: sightingId, resimulation });
}

/**
 * Serves the report routes. Returns false when the path is not one of them, so the caller can
 * go on to its other routes. Errors after the path is claimed end in a fixed 500 body.
 */
export function routeReports(
  db: DatabaseSync,
  options: ReportOptions,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== "/reports") return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return true;
  }
  postReport(db, options, req, res).catch(() => {
    // Internal detail stays in the process; the client gets a fixed body.
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    else res.destroy();
  });
  return true;
}
