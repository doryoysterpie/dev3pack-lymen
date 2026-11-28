// limen API entry point (E-02). Reads its configuration from the environment (the start script
// loads .env), loads the organizer key, migrates the database and serves HTTP.
import type { Server } from "node:http";
import { isIPv6, type AddressInfo } from "node:net";

import { chainabuseHook, parseChainabuseMode } from "./chainabuse.ts";
import { devnetMinter, registrationsFrom } from "./checkin.ts";
import { openDatabase } from "./db.ts";
import { isMainModule } from "./main-module.ts";
import { loadOrganizerKey } from "./organizer-key.ts";
import { loadRegistrationSalt } from "./registration.ts";
import { API_VERSION, createApiServer } from "./server.ts";
import { parseStationDisplaySecret } from "./station-token.ts";
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
  const organizerKey = loadOrganizerKey(env.ORGANIZER_KEYPAIR_PATH);
  const stationDisplayToken = parseStationDisplaySecret(
    env.STATION_DISPLAY_TOKEN,
  );
  const chainabuse = parseChainabuseMode(env.CHAINABUSE_POST);
  // Check-in (E-05) binds registrations with E-07's code under REGISTRATION_SALT and mints with
  // E-06's mintPass on devnet (SOLANA_RPC_URL, or the public devnet endpoint), paid for by the
  // organizer key. With REGISTRATION_SALT unset or empty, POST /checkins answers 503; a set but
  // short salt stops start-up, as it stops the import tool.
  const salt =
    env.REGISTRATION_SALT === undefined || env.REGISTRATION_SALT === ""
      ? undefined
      : loadRegistrationSalt(env.REGISTRATION_SALT);
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
    stationSigner: organizerKey,
    stationDisplayToken,
    nowMs: () => Date.now(),
    checkin:
      salt === undefined
        ? undefined
        : {
            registrations: registrationsFrom(db, salt),
            minter: devnetMinter(env.SOLANA_RPC_URL || undefined, organizerKey),
          },
    reports: {
      triageToken: env.TRIAGE_TOKEN || undefined,
      lists,
      // Without the lists no case can escalate, since the triage routes answer 503, so the
      // Chainabuse hook is built only from lists that loaded (E-13 on E-12's start-up).
      onEscalated:
        lists === null
          ? undefined
          : chainabuseHook(chainabuse, db, lists, (line) => console.log(line)),
    },
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
