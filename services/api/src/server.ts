// HTTP server for the limen API. E-02 adds the health endpoint; later units add their routes.
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { routeReports, type ReportOptions } from "./reports.ts";
import { schemaVersion } from "./db.ts";

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
    ...headers,
  });
  res.end(text);
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
      sendJson(res, 404, { error: "not_found" });
    } catch {
      // Internal detail stays in the process; the client gets a fixed body.
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.destroy();
    }
  });
}
