// E-03: the station page, one built file the API reads at start-up and serves at /station.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
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
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.ts";
import { start } from "./index.ts";
import { createApiServer } from "./server.ts";
import {
  loadStationPage,
  MAX_STATION_PAGE_BYTES,
  STATION_PAGE_DOCTYPE,
  STATION_PAGE_MARKER,
  STATION_PAGE_PATH,
} from "./station-page.ts";
import { stationDisplayToken } from "./station-token.ts";
import {
  TEST_STATION_DISPLAY_SECRET,
  TEST_STATION_SETTINGS,
} from "./test-station.ts";

const T = TEST_STATION_SETTINGS.now();
const STATION_BUILD = fileURLToPath(
  new URL("../../../apps/station/build.ts", import.meta.url),
);
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
  const outDir = realpathSync(
    mkdtempSync(join(tmpdir(), "limen-station-build-")),
  );
  try {
    const built = spawnSync(
      process.execPath,
      [STATION_BUILD, "--outDir", outDir],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        timeout: 120_000,
      },
    );
    assert.equal(built.status, 0, `build: ${built.stderr.slice(-600)}`);
    const page = loadStationPage(join(outDir, "index.html"));
    assert.ok(page !== null, "the station build wrote index.html");
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
        assert.equal(
          res.headers.get("content-type"),
          "text/html; charset=utf-8",
        );
        assert.equal(res.headers.get("cache-control"), "no-store");
        const body = Buffer.from(await res.arrayBuffer());
        assert.ok(body.equals(page), path);
        const html = body.toString("utf8");
        assert.match(html, /<canvas id="qr" hidden><\/canvas>/, path);
        assert.match(html, /<script type="module">/, path);
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
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("the page's QR request, to /api on the API's own origin, gets that station's QR", async () => {
  const { base, close } = await serve(null);
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
  const validPage = `${STATION_PAGE_DOCTYPE}\n${STATION_PAGE_MARKER}\n`;
  try {
    const file = join(dir, "index.html");
    writeFileSync(file, validPage);
    assert.equal(loadStationPage(file)?.toString(), validPage);
    const link = join(dir, "link.html");
    symlinkSync(file, link);
    assert.throws(() => loadStationPage(link), /is a symlink/);
    mkdirSync(join(dir, "folder.html"));
    assert.throws(
      () => loadStationPage(join(dir, "folder.html")),
      /is not a regular file/,
    );
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere", "index.html"), validPage);
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

test("hard links to a fake .env or fake keypair file are refused by content, and stop start-up before the database opens", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-station-page-")));
  try {
    const fakeEnv = join(dir, ".env");
    writeFileSync(
      fakeEnv,
      "ORGANIZER_KEYPAIR_PATH=/tmp/fake.json\nSTATION_DISPLAY_TOKEN=fake-env-token-0123456789abcdefghij\n",
    );
    const fakeKey = join(dir, "organizer.json");
    const keypairJson = JSON.stringify([
      ...Buffer.from(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
          "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "hex",
      ),
    ]);
    writeFileSync(fakeKey, keypairJson);

    const envHardLink = join(dir, "env-index.html");
    linkSync(fakeEnv, envHardLink);
    const keyHardLink = join(dir, "key-index.html");
    linkSync(fakeKey, keyHardLink);

    assert.throws(() => loadStationPage(envHardLink), /doctype/);
    assert.throws(() => loadStationPage(keyHardLink), /doctype/);

    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    for (const [label, link] of [
      ["fake .env hard link", envHardLink],
      ["fake keypair hard link", keyHardLink],
    ] as const) {
      const dbPath = join(dir, `${label.replace(/[^a-z]+/g, "-")}.db`);
      const env = {
        ORGANIZER_KEYPAIR_PATH: fakeKey,
        STATION_DISPLAY_TOKEN: TEST_STATION_DISPLAY_SECRET,
        API_PORT: String(port),
        DATABASE_PATH: dbPath,
      };
      await assert.rejects(
        start(env, link).then(({ server }) => {
          server.close();
        }),
        /doctype/,
        label,
      );
      assert.ok(!existsSync(dbPath), `${label}: no database was opened`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the station page loader checks exact doctype, build marker, size limit and key-scan hits, and createApiServer refuses unvalidated bytes", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-station-page-")));
  const marker = STATION_PAGE_MARKER;
  const maxBytes = MAX_STATION_PAGE_BYTES;
  try {
    const write = (name: string, content: string | Buffer): string => {
      const p = join(dir, name);
      writeFileSync(p, content);
      return p;
    };
    const valid = `<!doctype html>\n<html><head></head><body>${marker}<script type="module"></script></body></html>\n`;
    assert.ok(
      loadStationPage(write("ok.html", valid))?.equals(Buffer.from(valid)),
    );

    assert.throws(
      () =>
        loadStationPage(
          write(
            "upper-doctype.html",
            valid.replace("<!doctype html>", "<!DOCTYPE html>"),
          ),
        ),
      /doctype/,
    );
    assert.throws(
      () => loadStationPage(write("leading-space.html", ` ${valid}`)),
      /doctype/,
    );
    assert.throws(
      () => loadStationPage(write("no-marker.html", valid.replace(marker, ""))),
      /marker/,
    );

    const exactPrefix = `<!doctype html>\n${marker}\n`;
    const atLimit = Buffer.concat([
      Buffer.from(exactPrefix),
      Buffer.alloc(maxBytes - Buffer.byteLength(exactPrefix), " "),
    ]);
    assert.equal(atLimit.length, maxBytes);
    assert.equal(
      loadStationPage(write("at-limit.html", atLimit))?.length,
      maxBytes,
    );

    const overLimit = Buffer.concat([atLimit, Buffer.from(" ")]);
    assert.throws(
      () => loadStationPage(write("over-limit.html", overLimit)),
      /larger than/,
    );

    const keypairJson = JSON.stringify([
      ...Buffer.from(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
          "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "hex",
      ),
    ]);
    const withKey = `${exactPrefix}${keypairJson}\n`;
    assert.throws(
      () => loadStationPage(write("with-key.html", withKey)),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /private-key material \(json-keypair\)/);
        assert.ok(!err.message.includes("157"), "error carries no key byte");
        return true;
      },
    );

    const db = openDatabase(":memory:");
    assert.throws(
      () =>
        createApiServer({
          db,
          version: "test",
          ...TEST_STATION_SETTINGS,
          stationPage: Buffer.from("STATION_DISPLAY_TOKEN=fake\n"),
        }),
      /doctype/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
