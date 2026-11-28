// Station display link (E-03): writes the station page's address, with that station's own
// display token in the fragment, to ~/limen-station-links/<station ID>.url, and prints the path
// it wrote, not the token (rule 8). Open the address in the station's browser.
//
//   npm run station-link -w @limen/api -- <station ID>
//
// The tool takes no output path. It writes into ~/limen-station-links, which it makes at
// mode 700 if missing, and refuses when that folder is a symlink, not a directory, owned by
// another user, or writable by group or others. The file name is the station ID, which must be
// 1 to 64 characters of [A-Za-z0-9_-], and ".url". The file is created new, at mode 600; the
// tool refuses when a file or a symlink already has that name.
//
// Node has no openat, so the file is created by its path, not relative to the open folder. The
// tool opens the folder without following a symlink and checks what it opened; after creating
// the file, and before writing the token, it checks that the folder's path still names that
// folder and the file's path still names the file it created. If the folder is replaced in
// between, the file is created, empty, where the replaced path leads; the tool then writes no
// token and stops with an error, and that empty file stays (station-link.test.ts).
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isMainModule } from "./main-module.ts";
import {
  parseStationDisplaySecret,
  stationDisplayToken,
} from "./station-token.ts";

/** The station page as `npm run dev -w @limen/station` serves it. */
export const STATION_PAGE_URL = "http://127.0.0.1:5173/";
/** The one folder, in the home folder, the tool writes link files into. */
export const LINK_FOLDER = "limen-station-links";

const STATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE = "usage: npm run station-link -w @limen/api -- <station ID>";
const EXISTS =
  "the link file already exists; remove it and run the tool again.";

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

/**
 * Refuses a link folder that is a symlink, not a directory, not owned by `uid`, or writable by
 * group or others.
 */
function checkFolder(folder: string, stats: Stats, uid: number): void {
  const why = stats.isSymbolicLink()
    ? "a symlink"
    : !stats.isDirectory()
      ? "not a directory"
      : stats.uid !== uid
        ? "owned by another user"
        : (stats.mode & 0o022) !== 0
          ? "writable by group or others"
          : null;
  if (why !== null)
    throw new Error(
      `${folder} must be a directory owned by you and writable by you only; it is ${why}.`,
    );
}

/**
 * Writes the link for `args[0]` into ~/limen-station-links and returns what to print. `home` and
 * `uid` default to the user's own; tests pass others, and `beforeCreate`, which runs after the
 * folder checks and before the file is created.
 */
export function writeStationLink(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  options: {
    readonly home?: string;
    readonly uid?: number;
    readonly beforeCreate?: () => void;
  } = {},
): string {
  const station = args[0];
  if (args.length !== 1 || station === undefined || !STATION_ID.test(station))
    throw new Error(USAGE);
  const secret = parseStationDisplaySecret(env.STATION_DISPLAY_TOKEN);
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const folder = join(options.home ?? homedir(), LINK_FOLDER);
  try {
    mkdirSync(folder, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  checkFolder(folder, lstatSync(folder), uid);
  const folderFd = openSync(
    folder,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(folderFd);
    checkFolder(folder, opened, uid);
    const path = join(folder, `${station}.url`);
    options.beforeCreate?.();
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
      const now = lstatSync(folder);
      const created = fstatSync(fd);
      const named = lstatSync(path);
      if (
        now.dev !== opened.dev ||
        now.ino !== opened.ino ||
        named.dev !== created.dev ||
        named.ino !== created.ino
      )
        throw new Error(
          `${folder} changed while the link was being written; nothing was written.`,
        );
      writeSync(fd, `${stationLink(secret, station)}\n`);
    } finally {
      closeSync(fd);
    }
    return `Wrote the display link for station ${station} to ${path}.`;
  } finally {
    closeSync(folderFd);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(writeStationLink(process.env, process.argv.slice(2)));
  } catch (err) {
    console.error(
      `station-link: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
