// The station page (E-03): one self-contained HTML file, built by `node apps/station/build.ts`,
// which the API reads once at start-up and serves at /station
// (station-page.test.ts).
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { keyMaterialIn } from "./key-scan.ts";

/** Where the station build writes the page. */
export const STATION_PAGE_PATH = fileURLToPath(
  new URL("../../../apps/station/dist/index.html", import.meta.url),
);
/** Exact doctype written at byte 0 by the station build. */
export const STATION_PAGE_DOCTYPE = "<!doctype html>";
/** Build marker inserted into index.html by apps/station/vite.config.ts. */
export const STATION_PAGE_MARKER = "<!-- limen:station-page:v1 -->";
/** Upper size bound for the built single-file station page (256 KiB). */
export const MAX_STATION_PAGE_BYTES = 256 * 1024;

const DOCTYPE_BYTES = Buffer.from(STATION_PAGE_DOCTYPE, "utf8");
const MARKER_BYTES = Buffer.from(STATION_PAGE_MARKER, "utf8");

/**
 * Checks a station page by content. Throws unless `bytes` is at most `MAX_STATION_PAGE_BYTES`,
 * starts with `STATION_PAGE_DOCTYPE`, contains `STATION_PAGE_MARKER`, and has zero key-scan hits.
 */
export function assertStationPage(
  bytes: Buffer,
  label = "the station page",
): void {
  if (bytes.length > MAX_STATION_PAGE_BYTES)
    throw new Error(`${label} is larger than ${MAX_STATION_PAGE_BYTES} bytes`);
  if (!bytes.subarray(0, DOCTYPE_BYTES.length).equals(DOCTYPE_BYTES))
    throw new Error(`${label} does not start with the station build's doctype`);
  if (!bytes.includes(MARKER_BYTES))
    throw new Error(`${label} is missing the station build marker`);
  const hits = keyMaterialIn(bytes);
  if (hits.length > 0)
    throw new Error(`${label} holds private-key material (${hits.join(", ")})`);
}

/**
 * Reads at most `maxBytes` from `fd`, refusing non-regular files, files whose link count is not 1,
 * and files over the size limit before or during the read.
 */
function readBounded(fd: number, maxBytes: number, label: string): Buffer {
  const opened = fstatSync(fd);
  if (!opened.isFile()) throw new Error(`${label} is not a regular file`);
  if (opened.nlink !== 1)
    throw new Error(`${label} has link count ${opened.nlink}, expected 1`);
  if (opened.size > maxBytes)
    throw new Error(`${label} is larger than ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.allocUnsafe(16 * 1024);
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > maxBytes)
      throw new Error(`${label} is larger than ${maxBytes} bytes`);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  const after = fstatSync(fd);
  if (after.nlink !== 1)
    throw new Error(`${label} has link count ${after.nlink}, expected 1`);
  return Buffer.concat(chunks, total);
}

/**
 * The page's bytes, or null when no file is at `path`. Throws when `path` or a folder above it is
 * a symlink, when the opened file is not a regular file with link count 1, when it cannot be
 * looked at, or when its content fails `assertStationPage`.
 */
export function loadStationPage(path: string): Buffer | null {
  const label = `the station page at ${path}`;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(`${label} could not be read (${code})`, {
      cause: err,
    });
  }
  if (stat.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path))
    throw new Error(`${label} is a symlink, or under one`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  // O_NOFOLLOW and O_NONBLOCK: a file swapped for a symlink or a FIFO after the checks above is
  // refused or does not block start-up; fstat then checks the file opened.
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    bytes = readBounded(fd, MAX_STATION_PAGE_BYTES, label);
  } finally {
    closeSync(fd);
  }
  assertStationPage(bytes, label);
  return bytes;
}
