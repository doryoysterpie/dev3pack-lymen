// E-03: the station page, one built file the API reads at start-up and serves at /station.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "./db.ts";
import { start } from "./index.ts";
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

test("a page the API cannot look at stops start-up rather than reading as not built; a page under a file is absent", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-station-page-")));
  const shut = join(dir, "shut");
  try {
    mkdirSync(shut);
    writeFileSync(join(shut, "index.html"), "page\n");
    // No search permission on the folder, so lstat fails with EACCES.
    chmodSync(shut, 0o600);
    assert.throws(
      () => loadStationPage(join(shut, "index.html")),
      /could not be read/,
    );
    writeFileSync(join(dir, "file"), "x");
    assert.equal(loadStationPage(join(dir, "file", "index.html")), null);
  } finally {
    chmodSync(shut, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start-up stops on a symlinked station page, before it opens the database or listens", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-station-page-")));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, "page\n");
    const link = join(dir, "index.html");
    symlinkSync(page, link);
    // RFC 8032 TEST 1's keypair, as solana-keygen writes one.
    const key = join(dir, "organizer.json");
    writeFileSync(
      key,
      JSON.stringify([
        ...Buffer.from(
          "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
          "hex",
        ),
      ]),
    );
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const env = {
      ORGANIZER_KEYPAIR_PATH: key,
      STATION_DISPLAY_TOKEN: TEST_STATION_DISPLAY_SECRET,
      API_PORT: String(port),
      DATABASE_PATH: join(dir, "limen.db"),
    };
    await assert.rejects(
      start(env, link).then(({ server }) => {
        server.close();
      }),
      /is a symlink/,
    );
    assert.ok(!existsSync(join(dir, "limen.db")), "no database was opened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
