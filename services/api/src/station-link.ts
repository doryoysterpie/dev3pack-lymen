// Station display link (E-03): writes the station page's address, with that station's own
// display token in the fragment, to a file the operator names, and prints only where it wrote
// it, never the token (rule 8). Open the address in the station's browser.
//
// The file must be outside the repository. The station page's dev server serves files from
// the whole workspace by /@fs/ path, so a link file inside the repository could be read by any
// page on localhost. The tool resolves symlinks before it checks.
//
//   npm run station-link -w @limen/api -- <station ID> <output file>
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./main-module.ts";
import {
  parseStationDisplaySecret,
  stationDisplayToken,
} from "./station-token.ts";

/** The station page as `npm run dev -w @limen/station` serves it. */
export const STATION_PAGE_URL = "http://127.0.0.1:5173/";

const STATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REPOSITORY = realpathSync(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const INSIDE_REPOSITORY =
  "the link file must be outside the repository, where the station page's dev server cannot serve it.";

/** `path` with symlinks resolved, for a path whose last parts may not exist yet. */
function realPathOf(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/** Whether `path` lies inside the repository, symlinks resolved. */
export function insideRepository(path: string): boolean {
  const from = relative(REPOSITORY, realPathOf(resolve(path)));
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
}
const USAGE =
  "usage: npm run station-link -w @limen/api -- <station ID> <output file>";

/** The station page's address for `station`, with its display token in the fragment. */
export function stationLink(
  secret: string,
  station: string,
  page: string = STATION_PAGE_URL,
): string {
  const url = new URL(page);
  url.searchParams.set("station", station);
  url.hash = `token=${stationDisplayToken(secret, station)}`;
  return url.href;
}

/** Writes the link to `args[1]`, readable by its owner only, and returns what to print. */
export function writeStationLink(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): string {
  const [station, out] = args;
  if (station === undefined || !STATION_ID.test(station) || !out)
    throw new Error(USAGE);
  const secret = parseStationDisplaySecret(env.STATION_DISPLAY_TOKEN);
  const path = resolve(out);
  if (insideRepository(path)) throw new Error(INSIDE_REPOSITORY);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stationLink(secret, station)}\n`, { mode: 0o600 });
  // writeFileSync sets the mode only when it creates the file.
  chmodSync(path, 0o600);
  return `Wrote the display link for station ${station} to ${path}.`;
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(writeStationLink(process.env, process.argv.slice(2)));
  } catch (err) {
    // The messages name the variable or the usage, never the secret or a token.
    console.error(
      `station-link: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
