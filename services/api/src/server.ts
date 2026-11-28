// HTTP server for the limen API. E-02 adds the health endpoint; E-03 adds the station QR
// endpoint for the station display; E-05 adds POST /checkins. Later units add their routes.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  checkIn,
  type CheckinRegistrations,
  type PassMinter,
} from "./checkin.ts";
import { hasRepeatedKey } from "./json-keys.ts";
import { routeReports, type ReportOptions } from "./reports.ts";
import { schemaVersion } from "./db.ts";
import {
  issueStationQr,
  stationAllowlist,
  STATION_QR_ROTATION_S,
  type StationSigner,
} from "./station-qr.ts";
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
   * (station-token.ts). A display sends its own station's token, never this secret.
   */
  readonly stationDisplayToken: string;
  /**
   * The current Unix time in milliseconds: the one clock the API reads. A time in whole seconds
   * is floor(nowMs() / 1000), never a second clock, so a station QR's 60 s window is checked to
   * the millisecond. createApiServer refuses a context without it.
   */
  readonly nowMs: () => number;
  /**
   * Check-in dependencies (E-05): registration binding from E-07, minting from E-06, and the
   * secret each pass's mint keypair is derived from. The running API (index.ts) sets them when
   * REGISTRATION_SALT is set; unset, POST /checkins answers 503.
   */
  readonly checkin?: {
    readonly registrations: CheckinRegistrations;
    readonly minter: PassMinter;
    readonly mintSecret: string;
  };
}

/** Largest check-in body accepted, in bytes; a larger one is answered 413. */
export const MAX_CHECKIN_BODY_BYTES = 8 * 1024;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function postCheckin(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }
  if (ctx.checkin === undefined) {
    sendJson(res, 503, { error: "check_in_unavailable" });
    return;
  }
  if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  const raw = await readBody(req, MAX_CHECKIN_BODY_BYTES);
  if (raw === null) {
    sendJson(res, 413, { error: "body_too_large" }, { connection: "close" });
    return;
  }
  const text = raw.toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  // JSON.parse keeps a repeated key's last value; another reader may keep its first.
  if (hasRepeatedKey(text)) {
    sendJson(res, 400, { error: "invalid_request", reason: "repeated_key" });
    return;
  }
  const outcome = await checkIn(
    {
      db: ctx.db,
      allowlist: stationAllowlist([ctx.stationSigner.publicKey]),
      registrations: ctx.checkin.registrations,
      minter: ctx.checkin.minter,
      mintSecret: ctx.checkin.mintSecret,
    },
    body,
    ctx.nowMs(),
  );
  sendJson(res, outcome.status, outcome.body);
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
  // One reading of the clock serves the session choice, the QR and its remaining time.
  const nowMs = ctx.nowMs();
  const now = Math.floor(nowMs / 1000);
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
    // How long the QR has left as it leaves the API, to the millisecond. The page counts its
    // own round trip off this, so it never draws a QR that expired on the way.
    expires_in_ms: payload.expires_at * 1000 - nowMs,
  });
}

export function createApiServer(ctx: ApiContext): Server {
  // A JavaScript caller is not held to the type, so the clock is checked here too.
  if (typeof ctx.nowMs !== "function") {
    throw new TypeError(
      "createApiServer needs nowMs, the API's millisecond clock",
    );
  }
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
      if (pathname === "/checkins") {
        postCheckin(ctx, req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: "internal" });
          else res.destroy();
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
