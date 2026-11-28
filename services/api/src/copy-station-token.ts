// Station display token (E-03): copies one station's display token to the macOS clipboard, for
// pasting into that station's page, and prints only that it did.
//
//   npm run station-token -w @limen/api -- <station ID>
//
// The token is the HMAC that station-token.ts derives from STATION_DISPLAY_TOKEN. The tool
// writes it to pbcopy's standard input, so it is not on any command line, and it writes no
// file. It refuses off macOS, where there is no pbcopy.
import { spawnSync } from "node:child_process";

import { isMainModule } from "./main-module.ts";
import {
  parseStationDisplaySecret,
  stationDisplayToken,
} from "./station-token.ts";

const STATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE = "usage: npm run station-token -w @limen/api -- <station ID>";

/** Copies the token for `args[0]` and returns what to print. Throws with the message to show. */
export function copyStationToken(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  platform: string = process.platform,
): string {
  const station = args[0];
  if (args.length !== 1 || station === undefined || !STATION_ID.test(station))
    throw new Error(USAGE);
  const secret = parseStationDisplaySecret(env.STATION_DISPLAY_TOKEN);
  if (platform !== "darwin")
    throw new Error(
      "this tool copies the token with pbcopy, which is on macOS only; run it on a Mac.",
    );
  const copied = spawnSync("pbcopy", [], {
    input: stationDisplayToken(secret, station),
    stdio: ["pipe", "ignore", "ignore"],
    env,
  });
  if (copied.error !== undefined || copied.status !== 0)
    throw new Error("pbcopy failed, so the token was not copied.");
  return `Copied the display token for ${station}.`;
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(copyStationToken(process.env, process.argv.slice(2)));
  } catch (err) {
    console.error(
      `station-token: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
