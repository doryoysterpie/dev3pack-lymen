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
 * a symlink, or when it is not a regular file.
 */
export function loadStationPage(path: string): Buffer | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path))
    throw new Error(`the station page at ${path} is a symlink, or under one`);
  if (!stat.isFile())
    throw new Error(`the station page at ${path} is not a regular file`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile())
      throw new Error(`the station page at ${path} is not a regular file`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
