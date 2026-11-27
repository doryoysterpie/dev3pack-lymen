// limen API entry point (E-02). Reads its configuration from the environment (the start script
// loads .env), loads the organizer key, migrates the database and serves HTTP.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import { openDatabase } from "./db.ts";
import { loadOrganizerKey } from "./organizer-key.ts";
import { API_VERSION, createApiServer } from "./server.ts";

export interface StartedApi {
  readonly server: Server;
  readonly url: string;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `API_PORT must be an integer from 0 to 65535, got "${value}".`,
    );
  }
  return port;
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
  const server = createApiServer({ db, version: API_VERSION });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port: bound } = server.address() as AddressInfo;
  return { server, url: `http://${host}:${bound}` };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  start().then(
    ({ url }) => console.log(`limen api ${API_VERSION} listening on ${url}`),
    (err: unknown) => {
      // One readable line and no stack trace. Key errors never carry key material.
      console.error(
        `limen api: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    },
  );
}
