// limen API entry point (E-02). Reads its configuration from the environment (the start script
// loads .env), loads the organizer key, migrates the database and serves HTTP.
import type { Server } from "node:http";
import { isIPv6, type AddressInfo } from "node:net";

import { openDatabase } from "./db.ts";
import { isMainModule } from "./main-module.ts";
import { loadOrganizerKey } from "./organizer-key.ts";
import { API_VERSION, createApiServer } from "./server.ts";
import { bundledLists, type DomainLists } from "./triage.ts";

export interface StartedApi {
  readonly server: Server;
  readonly url: string;
}

/**
 * Reads API_PORT: unset or empty (an `API_PORT=` line in .env) gives 8787; anything else, a
 * value of only spaces included, must be the digits of an integer from 1 to 65535. The error
 * never echoes the value.
 */
export function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8787;
  const port = /^[0-9]{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error("API_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

/** The URL of a listening address, with an IPv6 host in square brackets. */
export function listenUrl(host: string, port: number): string {
  return `http://${isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/** Starts the API. Throws a configuration error with an operator-readable message. */
export async function start(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedApi> {
  // Loaded first so a bad key file stops start-up before anything else happens.
  // E-03 hands the key to the station QR signer.
  loadOrganizerKey(env.ORGANIZER_KEYPAIR_PATH);
  const port = parsePort(env.API_PORT);
  const host = env.API_HOST || "127.0.0.1";
  const db = openDatabase(env.DATABASE_PATH || "limen.db");
  // The triage lists load once, here. If they cannot, the API still starts and serves /health,
  // and only the triage routes answer 503 (E-12).
  let lists: DomainLists | null;
  try {
    lists = bundledLists();
  } catch {
    lists = null;
    console.error(
      "limen api: the triage domain lists did not load, so the triage routes answer 503.",
    );
  }
  // The dashboard's JSON routes answer 503 until TRIAGE_TOKEN is set (E-12).
  const server = createApiServer({
    db,
    version: API_VERSION,
    reports: { triageToken: env.TRIAGE_TOKEN || undefined, lists },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port: bound } = server.address() as AddressInfo;
  return { server, url: listenUrl(host, bound) };
}

if (isMainModule(import.meta.url)) {
  start().then(
    ({ url }) => console.log(`limen api ${API_VERSION} listening on ${url}`),
    (err: unknown) => {
      // One readable line and no stack trace. No key error carries ORGANIZER_KEYPAIR_PATH's
      // value or key material. Other errors may name the host or port, which are not secret.
      console.error(
        `limen api: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    },
  );
}
