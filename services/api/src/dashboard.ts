// Triage dashboard routes (E-12). GET /dashboard serves a plain page and its script and style
// from services/api/dashboard. The JSON routes behind it need the triage token as a bearer
// token, because they show evidence and change case status:
//   GET  /cases                 every case, most recently updated first
//   GET  /cases/:id             one case and its evidence, each sighting with its bundle
//   POST /cases/:id/escalate    a human escalates the case
//   POST /cases/:id/dismiss     a human dismisses the case
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import type { StoredBundle } from "./evidence.ts";
import {
  caseEvidence,
  decideCase,
  listCases,
  loadCase,
  type CaseView,
  type DomainLists,
} from "./triage.ts";

/** The shortest triage token the routes accept. */
export const MIN_TRIAGE_TOKEN_LENGTH = 32;

export interface DashboardOptions {
  /** The bearer token for the JSON routes. Unset or too short: they answer 503. */
  readonly triageToken: string | undefined;
  readonly lists: DomainLists;
  readonly now: () => number;
  /**
   * Called with the case ID when a human's escalate moves a case to escalated (E-13, pending the
   * owner's ruling that manual escalation also goes to Chainabuse). A failure inside it never
   * changes the response.
   */
  readonly onEscalated?: (caseId: number) => void;
}

const asset = (name: string): Buffer =>
  readFileSync(new URL(`../dashboard/${name}`, import.meta.url));

const ASSETS: ReadonlyMap<string, { body: Buffer; type: string }> = new Map([
  [
    "/dashboard",
    { body: asset("index.html"), type: "text/html; charset=utf-8" },
  ],
  [
    "/dashboard.js",
    { body: asset("dashboard.js"), type: "text/javascript; charset=utf-8" },
  ],
  [
    "/dashboard.css",
    { body: asset("dashboard.css"), type: "text/css; charset=utf-8" },
  ],
]);

/** The page loads only its own script and style, and talks only to this API. */
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const CASE_PATH = /^\/cases\/([1-9][0-9]{0,15})(?:\/(escalate|dismiss))?$/;

function send(
  res: ServerResponse,
  status: number,
  body: Buffer | string,
  type: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  send(
    res,
    status,
    JSON.stringify(body),
    "application/json; charset=utf-8",
    headers,
  );
}

/** Compares the bearer token with the expected one without leaking where they differ. */
function hasBearerToken(req: IncomingMessage, expected: string): boolean {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!match?.[1]) return false;
  const digest = (s: string): Buffer =>
    createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(match[1]), digest(expected));
}

/** The JSON form of a case. */
export function caseJson(view: CaseView): Record<string, unknown> {
  return {
    id: view.id,
    status: view.status,
    decided_by: view.decidedBy,
    domain: view.domain,
    program_ids: view.programIds,
    recipients: view.recipients,
    sightings: view.sightings,
    independent_devices: view.inputs.independentDevices,
    drain_pattern: view.inputs.drainPattern,
    domain_listed: view.inputs.domainListed,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}

/** The JSON form of one sighting's evidence bundle. */
export function evidenceJson(bundle: StoredBundle): Record<string, unknown> {
  return {
    sighting_id: bundle.sightingId,
    received_at: bundle.receivedAt,
    device_hash: bundle.deviceHash,
    payload: bundle.payload,
    url: bundle.url,
    transaction:
      bundle.transaction === null
        ? null
        : Buffer.from(bundle.transaction).toString("base64"),
    simulation: bundle.simulation,
    summary: JSON.parse(bundle.summaryJson) as unknown,
    program_ids: bundle.programIds,
    recipients: bundle.recipients,
    reported_at: bundle.reportedAt,
    app_version: bundle.appVersion,
    wallet: bundle.wallet,
    resimulation:
      bundle.resimulation === null
        ? null
        : {
            at: bundle.resimulation.at,
            matches: bundle.resimulation.matches,
            drain_pattern: bundle.resimulation.drainPattern,
          },
  };
}

function authorized(
  options: DashboardOptions,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const token = options.triageToken;
  if (token === undefined || token.length < MIN_TRIAGE_TOKEN_LENGTH) {
    sendJson(res, 503, { error: "triage_token_unset" });
    return false;
  }
  if (!hasBearerToken(req, token)) {
    sendJson(
      res,
      401,
      { error: "unauthorized" },
      { "www-authenticate": "Bearer" },
    );
    return false;
  }
  return true;
}

function methodIs(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): boolean {
  if (req.method === method) return true;
  sendJson(res, 405, { error: "method_not_allowed" }, { allow: method });
  return false;
}

/**
 * Serves the dashboard routes. Returns false when the path is not one of them. Runs
 * synchronously, so the caller's error handling covers it.
 */
export function routeDashboard(
  db: DatabaseSync,
  options: DashboardOptions,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  const file = ASSETS.get(pathname);
  if (file !== undefined) {
    if (methodIs(req, res, "GET")) {
      send(res, 200, file.body, file.type, {
        "content-security-policy": DASHBOARD_CSP,
        "referrer-policy": "no-referrer",
      });
    }
    return true;
  }

  if (pathname === "/cases") {
    if (methodIs(req, res, "GET") && authorized(options, req, res)) {
      sendJson(res, 200, { cases: listCases(db, options.lists).map(caseJson) });
    }
    return true;
  }

  const match = CASE_PATH.exec(pathname);
  if (match === null) return false;
  const caseId = Number(match[1]);
  const action = match[2] as "escalate" | "dismiss" | undefined;

  if (action === undefined) {
    if (methodIs(req, res, "GET") && authorized(options, req, res)) {
      const view = loadCase(db, caseId, options.lists);
      if (view === null) sendJson(res, 404, { error: "unknown_case" });
      else {
        sendJson(res, 200, {
          case: caseJson(view),
          evidence: caseEvidence(db, caseId).map(evidenceJson),
        });
      }
    }
    return true;
  }

  if (methodIs(req, res, "POST") && authorized(options, req, res)) {
    const result = decideCase(db, caseId, action, options.lists, options.now());
    if (
      action === "escalate" &&
      result.outcome === "decided" &&
      options.onEscalated !== undefined
    ) {
      try {
        options.onEscalated(caseId);
      } catch {
        // The decision stands either way; the hook's failure stays in the process.
      }
    }
    if (result.outcome === "not_found")
      sendJson(res, 404, { error: "unknown_case" });
    else
      sendJson(res, 200, {
        outcome: result.outcome,
        case: caseJson(result.case),
      });
  }
  return true;
}
