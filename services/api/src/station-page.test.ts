// E-03: the station page, one built file the API reads at start-up and serves at /station.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "./db.ts";
import { createApiServer } from "./server.ts";
import { loadStationPage, STATION_PAGE_PATH } from "./station-page.ts";
import { stationDisplayToken } from "./station-token.ts";
import {
  TEST_STATION_DISPLAY_SECRET,
  TEST_STATION_SETTINGS,
} from "./test-station.ts";

const T = TEST_STATION_SETTINGS.now();
const README = readFileSync(
  new URL("../../../apps/station/README.md", import.meta.url),
  "utf8",
);

async function serve(stationPage: Buffer | null) {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', ${T});
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-2', 'Day 2', ${T - 60}, ${T + 3600});
  `);
  const server = createApiServer({
    db,
    version: "test",
    ...TEST_STATION_SETTINGS,
    stationPage,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return { base, close };
}

test("the station URL the README gives serves the built page, whatever its query", async () => {
  const documented =
    /`(http:\/\/127\.0\.0\.1:8787\/station\?station=st-front)`/.exec(
      README,
    )?.[1];
  assert.ok(documented !== undefined, "the README gives the station URL");
  const page = Buffer.from("<!doctype html><title>limen station</title>\n");
  const { base, close } = await serve(page);
  try {
    const url = new URL(documented);
    for (const path of [
      url.pathname + url.search,
      "/station",
      "/station?station=st-side&x=1",
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(page), path);
    }
    for (const path of [
      "/station/",
      "/station/index.html",
      "/station.html",
      "/index.html",
      "/",
    ])
      assert.equal((await fetch(base + path)).status, 404, path);
    const post = await fetch(`${base}/station`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await close();
  }
});

test("the page's QR request, to /api on the API's own origin, gets that station's QR", async () => {
  const { base, close } = await serve(Buffer.from("page"));
  try {
    const token = stationDisplayToken(TEST_STATION_DISPLAY_SECRET, "st-front");
    const res = await fetch(`${base}/api/stations/st-front/qr`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { station: string; session: string };
    assert.deepEqual([body.station, body.session], ["st-front", "day-2"]);
    const without = await fetch(`${base}/api/stations/st-front/qr`);
    assert.equal(without.status, 401);
  } finally {
    await close();
  }
});

test("with no built page, /station answers 503 and names the build command", async () => {
  const { base, close } = await serve(null);
  try {
    const res = await fetch(`${base}/station?station=st-front`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: "station_page_not_built",
      build: "npm run build -w @limen/station",
    });
  } finally {
    await close();
  }
});

test("the page is read from a regular file; a symlink, a folder or a symlinked folder is refused, and a missing file is absent", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-station-page-")));
  try {
    const file = join(dir, "index.html");
    writeFileSync(file, "page\n");
    assert.equal(loadStationPage(file)?.toString(), "page\n");
    const link = join(dir, "link.html");
    symlinkSync(file, link);
    assert.throws(() => loadStationPage(link), /is a symlink/);
    mkdirSync(join(dir, "folder.html"));
    assert.throws(
      () => loadStationPage(join(dir, "folder.html")),
      /is not a regular file/,
    );
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere", "index.html"), "page\n");
    symlinkSync(join(dir, "elsewhere"), join(dir, "dist"));
    assert.throws(
      () => loadStationPage(join(dir, "dist", "index.html")),
      /is a symlink/,
    );
    assert.equal(loadStationPage(join(dir, "missing.html")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(STATION_PAGE_PATH.endsWith("/apps/station/dist/index.html"));
});
