// The station page (E-03): one self-contained HTML file, built by `npm run build -w
// @limen/station`, which the API reads once at start-up and serves at /station
// (station-page.test.ts).
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the station build writes the page. */
export const STATION_PAGE_PATH = fileURLToPath(
  new URL("../../../apps/station/dist/index.html", import.meta.url),
);

/**
 * The page's bytes, or null when no file is at `path`. Throws when `path` or a folder above it is
 * a symlink, when it is not a regular file, or when it cannot be looked at.
 */
export function loadStationPage(path: string): Buffer | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(`the station page at ${path} could not be read (${code})`, {
      cause: err,
    });
  }
  if (stat.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path))
    throw new Error(`the station page at ${path} is a symlink, or under one`);
  if (!stat.isFile())
    throw new Error(`the station page at ${path} is not a regular file`);
  // O_NOFOLLOW and O_NONBLOCK: a file swapped for a symlink or a FIFO after the checks above is
  // refused or does not block start-up; fstat then checks the file opened.
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new Error(`the station page at ${path} is not a regular file`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
