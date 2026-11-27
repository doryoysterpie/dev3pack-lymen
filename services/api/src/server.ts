// HTTP server for the limen API. E-02 adds the health endpoint; E-03 adds the station QR
// endpoint for the station display. Later units add their routes.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { routeReports, type ReportOptions } from "./reports.ts";
import { schemaVersion } from "./db.ts";
import {
  issueStationQr,
  STATION_QR_ROTATION_S,
  type StationSigner,
} from "./station-qr.ts";

/** The API version, read from services/api/package.json. */
export const API_VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  }
).version;

export interface ApiContext {
  /** Report triage settings (E-10 on). Unset means the system clock and no re-simulation. */
  readonly reports?: ReportOptions;
  readonly db: DatabaseSync;
  readonly version: string;
  /** Signs station QRs. In the running API this is the organizer key. */
  readonly stationSigner: StationSigner;
  /** The bearer token the station display sends to fetch QRs. */
  readonly stationDisplayToken: string;
  /** The current Unix time in whole seconds. */
  readonly now: () => number;
}

const STATION_QR_PATH = /^\/stations\/([A-Za-z0-9_-]{1,64})\/qr$/;

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

/** Compares the request's bearer token with the expected one without leaking where they differ. */
function hasBearerToken(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  const digest = (s: string): Buffer =>
    createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(match[1]), digest(expected));
}

function stationQr(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  stationId: string,
): void {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
    return;
  }
  if (!hasBearerToken(req, ctx.stationDisplayToken)) {
    sendJson(
      res,
      401,
      { error: "unauthorized" },
      { "www-authenticate": "Bearer" },
    );
    return;
  }
  const station = ctx.db
    .prepare("SELECT id FROM stations WHERE id = ?")
    .get(stationId);
  if (station === undefined) {
    sendJson(res, 404, { error: "unknown_station" });
    return;
  }
  const now = ctx.now();
  const session = ctx.db
    .prepare(
      "SELECT id, ends_at FROM sessions WHERE starts_at <= ? AND ? < ends_at ORDER BY starts_at DESC, id LIMIT 1",
    )
    .get(now, now) as { id: string; ends_at: number } | undefined;
  if (session === undefined) {
    sendJson(res, 409, { error: "no_active_session" });
    return;
  }
  const { text, payload } = issueStationQr({
    station: stationId,
    session: session.id,
    now,
    signer: ctx.stationSigner,
    // No QR outlives its session.
    notAfter: session.ends_at,
  });
  sendJson(res, 200, {
    qr: text,
    station: payload.station,
    session: payload.session,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    // Near a session's end the QR expires early, so the page refreshes when it does and picks
    // up the next session's QR then, rather than waiting the full 30 s with nothing shown.
    refresh_after_s: Math.min(STATION_QR_ROTATION_S, payload.expires_at - now),
  });
}

export function createApiServer(ctx: ApiContext): Server {
  return createServer((req, res) => {
    try {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      if (routeReports(ctx.db, ctx.reports ?? {}, req, res, pathname)) return;
      if (pathname === "/health") {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
          return;
        }
        sendJson(res, 200, {
          status: "ok",
          version: ctx.version,
          schema_version: schemaVersion(ctx.db),
        });
        return;
      }
      const qr = STATION_QR_PATH.exec(pathname);
      if (qr?.[1]) {
        stationQr(ctx, req, res, qr[1]);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch {
      // Internal detail stays in the process; the client gets a fixed body.
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.destroy();
    }
  });
}
