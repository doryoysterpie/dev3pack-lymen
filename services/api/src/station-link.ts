// Station display link (E-03): writes the station page's address, with that station's own
// display token in the fragment, to a file the operator names, and prints only where it wrote
// it, never the token (rule 8). Open the address in the station's browser.
//
// The file must be outside the repository, so it never sits where a server or a commit could pick
// it up. The check resolves symlinks with the operating system's own realpath, compares without
// letter case on macOS, whose default file system ignores it, and refuses a path that runs
// through a symlink that does not resolve. The file is created new, never written into an
// existing one or through a symlink, readable by its owner only.
//
//   npm run station-link -w @limen/api -- <station ID> <output file>
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
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
const REPOSITORY = realpathSync.native(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const INSIDE_REPOSITORY =
  "the link file must be outside the repository, where the station page's dev server cannot serve it.";
const DANGLING_LINK =
  "the link file's path holds a symlink that does not resolve; name a path without one.";
const EXISTS = "the link file already exists; remove it or name another file.";
// macOS's default file system (APFS) does not tell letter cases apart.
const IGNORES_CASE = process.platform === "darwin";

/** Whether anything, a symlink included, sits at `path`. existsSync follows symlinks. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `path` with symlinks resolved, for a path whose last parts may not exist yet. Throws when the
 * deepest part that exists is a symlink that does not resolve.
 */
function realPathOf(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!lexists(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  let real: string;
  try {
    real = realpathSync.native(existing);
  } catch {
    throw new Error(DANGLING_LINK);
  }
  return join(real, ...rest);
}

/** Whether `path` lies inside the repository, symlinks resolved. */
export function insideRepository(path: string): boolean {
  const fold = (p: string) => (IGNORES_CASE ? p.toLowerCase() : p);
  const from = relative(fold(REPOSITORY), fold(realPathOf(resolve(path))));
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
  // A new file only: never an existing one, which may be readable by others, nor a symlink.
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(EXISTS, { cause: err });
    throw err;
  }
  try {
    writeSync(fd, `${stationLink(secret, station)}\n`);
  } finally {
    closeSync(fd);
  }
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
