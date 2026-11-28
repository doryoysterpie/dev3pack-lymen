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
import { assertStationPage } from "./station-page.ts";
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
  /** STATION_DISPLAY_TOKEN, the secret each station's display token derives from. */
  readonly stationDisplayToken: string;
  /** The current Unix time in whole seconds. */
  readonly now: () => number;
  /** The current Unix time in milliseconds. Unset: now() * 1000. */
  readonly nowMs?: () => number;
  /** The built station page, served at /station (station-page.ts). Unset or null: 503. */
  readonly stationPage?: Buffer | null;
}

// The page asks for its QR at /api on the API's own origin.
const STATION_QR_PATH = /^(?:\/api)?\/stations\/([A-Za-z0-9_-]{1,64})\/qr$/;

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
  // The sessions, the clock and the signature share one BEGIN IMMEDIATE transaction, the write
  // lock the seed also takes.
  try {
    ctx.db.exec("BEGIN IMMEDIATE");
  } catch {
    sendJson(res, 503, { error: "busy" });
    return;
  }
  let issued: ReturnType<typeof issueStationQr> | null;
  try {
    const sessions = ctx.db
      .prepare(
        "SELECT id, starts_at, ends_at FROM sessions ORDER BY starts_at DESC, id",
      )
      .all() as { id: string; starts_at: number; ends_at: number }[];
    const nowMs = ctx.nowMs?.() ?? ctx.now() * 1000;
    const now = Math.floor(nowMs / 1000);
    const session = sessions.find((s) => s.starts_at <= now && now < s.ends_at);
    issued =
      session === undefined
        ? null
        : issueStationQr({
            station: stationId,
            session: session.id,
            now,
            signer: ctx.stationSigner,
            notAfter: session.ends_at,
          });
  } finally {
    ctx.db.exec("COMMIT");
  }
  if (issued === null) {
    sendJson(res, 409, { error: "no_active_session" });
    return;
  }
  const { text, payload } = issued;
  sendJson(res, 200, {
    qr: text,
    station: payload.station,
    session: payload.session,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
  });
}

export function createApiServer(ctx: ApiContext): Server {
  if (ctx.stationPage != null) assertStationPage(ctx.stationPage);
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
      if (pathname === "/station") {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
          return;
        }
        if (ctx.stationPage == null) {
          sendJson(res, 503, {
            error: "station_page_not_built",
            build: "node apps/station/build.ts",
          });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(ctx.stationPage);
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
