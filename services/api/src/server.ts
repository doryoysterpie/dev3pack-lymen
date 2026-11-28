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
import { issueStationQr, type StationSigner } from "./station-qr.ts";
import { stationDisplayToken } from "./station-token.ts";

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
  /**
   * STATION_DISPLAY_TOKEN, the secret each station's display token is derived from
   * (station-token.ts). A display sends its own station's token; the API refuses the secret.
   */
  readonly stationDisplayToken: string;
  /** The current Unix time in whole seconds. */
  readonly now: () => number;
  /**
   * The current Unix time in milliseconds, for checks that must not round to the second, such
   * as a station QR's 60 s window (E-05). Unset: now() * 1000.
   */
  readonly nowMs?: () => number;
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
  // Each display holds its own station's token, so one display's token gets no other
  // station's QR.
  if (
    !hasBearerToken(
      req,
      stationDisplayToken(ctx.stationDisplayToken, stationId),
    )
  ) {
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
  const sessions = ctx.db
    .prepare(
      "SELECT id, starts_at, ends_at FROM sessions ORDER BY starts_at DESC, id",
    )
    .all() as { id: string; starts_at: number; ends_at: number }[];
  // The clock is read once, after the last database read and just before issueStationQr signs.
  // The session choice and issued_at both come from this reading.
  const nowMs = ctx.nowMs?.() ?? ctx.now() * 1000;
  const now = Math.floor(nowMs / 1000);
  const session = sessions.find((s) => s.starts_at <= now && now < s.ends_at);
  if (session === undefined) {
    sendJson(res, 409, { error: "no_active_session" });
    return;
  }
  const { text, payload } = issueStationQr({
    station: stationId,
    session: session.id,
    now,
    signer: ctx.stationSigner,
    notAfter: session.ends_at,
  });
  sendJson(res, 200, {
    qr: text,
    station: payload.station,
    session: payload.session,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
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
