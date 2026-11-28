// E-03: the station page's dev and preview servers, started with this app's own
// vite.config.ts, must not serve key, database or repository files. Each test puts uniquely named
// stand-ins where such files would sit and owes 403 or 404 for them, by /@fs/ path, with ?raw or
// ?import&raw, or from another page on localhost.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build, createServer, preview } from "vite";

const APP = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const MARKER = "dev-server-test-token-marker";

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("the dev server refuses a key, database or repository file outside the station app", async () => {
  // Uniquely named stand-ins where the repository keeps secrets and data, each created with flag
  // "wx", so an existing file is not overwritten, and removed afterwards.
  const tag = `dev-server-test-${process.pid}`;
  const keysDir = join(REPO, "keys");
  const hadKeysDir = existsSync(keysDir);
  const files = [
    join(keysDir, `${tag}.json`),
    join(REPO, `${tag}.keypair.json`),
    join(REPO, "services", "api", `${tag}.db`),
    join(REPO, `${tag}.txt`),
  ];
  mkdirSync(keysDir, { recursive: true });
  const written: string[] = [];
  const server = await createServer({
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    logLevel: "silent",
    server: { port: await freePort(), strictPort: true },
  });
  try {
    for (const file of files) {
      writeFileSync(file, `${MARKER}\n`, { flag: "wx" });
      written.push(file);
    }
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;
    const get = (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { origin: "http://localhost:8081" },
      });
    for (const file of files) {
      for (const path of [
        `/@fs${file}`,
        `/@fs${file}?raw`,
        `/@fs${file}?import&raw`,
      ]) {
        const res = await get(path);
        const body = await res.text();
        assert.ok(
          res.status === 403 || res.status === 404,
          `${path} answered ${res.status}`,
        );
        assert.ok(!body.includes(MARKER), `${path} served the file`);
      }
    }
    // The page itself still loads.
    for (const path of ["/", "/src/main.ts"]) {
      assert.equal((await get(path)).status, 200, path);
    }
  } finally {
    await server.close();
    for (const file of written) rmSync(file, { force: true });
    if (!hadKeysDir) rmdirSync(keysDir);
  }
});

test("the dev and preview servers serve no key or database through a workspace link, the station folder or the build, and send no CORS header", async () => {
  // Stand-ins, each created with flag "wx", so an existing file is not overwritten, and removed
  // afterwards.
  const tag = `dev-server-test-${process.pid}`;
  const api = join(REPO, "services", "api");
  const files = {
    apiDb: join(api, `${tag}.db`),
    apiKeypair: join(api, `${tag}.keypair.json`),
    stationKeypair: join(APP, `${tag}-keypair.json`),
  };
  const written: string[] = [];
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  const config = {
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    logLevel: "silent" as const,
  };
  const dev = await createServer({
    ...config,
    server: { port: await freePort(), strictPort: true },
  });
  let previewServer: Awaited<ReturnType<typeof preview>> | null = null;
  try {
    for (const file of Object.values(files)) {
      writeFileSync(file, `${MARKER}\n`, { flag: "wx" });
      written.push(file);
    }
    await dev.listen();
    const devPort = (dev.httpServer!.address() as AddressInfo).port;
    const get = (port: number, path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { origin: "http://localhost:8081" },
      });
    const owesRefusal = async (port: number, path: string) => {
      const res = await get(port, path);
      const body = await res.text();
      assert.ok(
        res.status === 403 || res.status === 404,
        `${path} answered ${res.status}`,
      );
      assert.ok(!body.includes(MARKER), `${path} served the file`);
    };
    const linked = join(REPO, "node_modules", "@limen", "api");
    for (const path of [
      `/@fs${join(linked, `${tag}.db`)}`,
      `/@fs${join(linked, `${tag}.keypair.json`)}`,
      `/@fs${files.apiDb}`,
      `/@fs${files.apiKeypair}`,
      `/@fs${files.stationKeypair}`,
      `/${tag}-keypair.json`,
      `/${tag}-keypair.json?raw`,
    ])
      await owesRefusal(devPort, path);
    // No CORS header, so another page on localhost cannot read what the dev server answers.
    const page = await get(devPort, "/src/main.ts");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("access-control-allow-origin"), null);

    await build({ ...config, build: { outDir, emptyOutDir: true } });
    previewServer = await preview({
      ...config,
      build: { outDir },
      preview: { port: await freePort(), strictPort: true },
    });
    const previewPort = (previewServer.httpServer.address() as AddressInfo)
      .port;
    for (const path of [
      `/${tag}-keypair.json`,
      `/@fs${files.stationKeypair}`,
      `/@fs${join(linked, `${tag}.db`)}`,
    ])
      await owesRefusal(previewPort, path);
    const built = await get(previewPort, "/");
    assert.equal(built.status, 200);
    assert.equal(built.headers.get("access-control-allow-origin"), null);
  } finally {
    await dev.close();
    if (previewServer !== null)
      await new Promise<void>((resolve) =>
        previewServer!.httpServer.close(() => resolve()),
      );
    for (const file of written) rmSync(file, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("an organizer key with an ordinary JSON name in apps/station/build gets 403 from the dev and preview servers, and the dev server serves nothing in apps/station but src and index.html", async () => {
  const buildDir = join(APP, "build");
  const hadBuildDir = existsSync(buildDir);
  mkdirSync(buildDir, { recursive: true });
  const key = join(buildDir, `organizer-${process.pid}.json`);
  // A stand-in, created with flag "wx", so an existing file is not overwritten.
  writeFileSync(key, `${MARKER}\n`, { flag: "wx" });
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  const config = {
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    logLevel: "silent" as const,
  };
  const dev = await createServer({
    ...config,
    server: { port: await freePort(), strictPort: true },
  });
  let previewServer: Awaited<ReturnType<typeof preview>> | null = null;
  const status = async (port: number, path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.text();
    assert.ok(!body.includes(MARKER), `${path} served the key`);
    return { status: res.status, body };
  };
  try {
    await dev.listen();
    const devPort = (dev.httpServer!.address() as AddressInfo).port;
    const name = `organizer-${process.pid}.json`;
    for (const path of [
      `/build/${name}`,
      `/build/${name}?raw`,
      `/build/${name}?import`,
      `/@fs${key}`,
      "/vite.config.ts",
      "/package.json",
      "/README.md",
    ])
      assert.equal((await status(devPort, path)).status, 403, `dev ${path}`);
    // The page and the modules it loads still answer.
    assert.equal((await status(devPort, "/")).status, 200);
    const main = await status(devPort, "/src/main.ts");
    assert.equal(main.status, 200);
    const imports = [...main.body.matchAll(/from\s+"(\/[^"]+)"/g)].map(
      (m) => m[1]!,
    );
    assert.ok(imports.some((i) => i.includes("qrcode")));
    for (const path of imports)
      assert.equal((await status(devPort, path)).status, 200, path);

    await build({ ...config, build: { outDir, emptyOutDir: true } });
    previewServer = await preview({
      ...config,
      build: { outDir },
      preview: { port: await freePort(), strictPort: true },
    });
    const previewPort = (previewServer.httpServer.address() as AddressInfo)
      .port;
    for (const path of [
      `/build/${name}`,
      `/@fs${key}`,
      "/vite.config.ts",
      "/package.json",
    ])
      assert.equal(
        (await status(previewPort, path)).status,
        403,
        `preview ${path}`,
      );
    assert.equal((await status(previewPort, "/")).status, 200);
  } finally {
    await dev.close();
    if (previewServer !== null)
      await new Promise<void>((resolve) =>
        previewServer!.httpServer.close(() => resolve()),
      );
    rmSync(key, { force: true });
    if (!hadBuildDir) rmSync(buildDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("a station named keys reaches the API through the dev and preview servers' proxy", async () => {
  // A stand-in API that records the paths it is asked for.
  const asked: string[] = [];
  const api = createHttpServer((req, res) => {
    asked.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"stand_in":true}');
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const before = process.env.STATION_API_URL;
  process.env.STATION_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  const config = {
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    logLevel: "silent" as const,
  };
  const dev = await createServer({
    ...config,
    server: { port: await freePort(), strictPort: true },
  });
  let previewServer: Awaited<ReturnType<typeof preview>> | null = null;
  try {
    await dev.listen();
    const devPort = (dev.httpServer!.address() as AddressInfo).port;
    await build({ ...config, build: { outDir, emptyOutDir: true } });
    previewServer = await preview({
      ...config,
      build: { outDir },
      preview: { port: await freePort(), strictPort: true },
    });
    const previewPort = (previewServer.httpServer.address() as AddressInfo)
      .port;
    for (const port of [devPort, previewPort]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/stations/keys/qr`);
      assert.equal(res.status, 200, `port ${port}`);
      assert.equal(await res.text(), '{"stand_in":true}');
    }
    assert.deepEqual(asked, ["/stations/keys/qr", "/stations/keys/qr"]);
  } finally {
    await dev.close();
    if (previewServer !== null)
      await new Promise<void>((resolve) =>
        previewServer!.httpServer.close(() => resolve()),
      );
    await new Promise<void>((resolve) => api.close(() => resolve()));
    if (before === undefined) delete process.env.STATION_API_URL;
    else process.env.STATION_API_URL = before;
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("the build fails when its output holds a file Vite's manifest does not name, as a plugin's stray organizer.json", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  try {
    await assert.rejects(
      build({
        configFile: join(APP, "vite.config.ts"),
        root: APP,
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
        // A plugin that puts an extra file in the output, as a stray asset would.
        plugins: [
          {
            name: "test-stray-file",
            generateBundle() {
              this.emitFile({
                type: "asset",
                fileName: "organizer.json",
                source: "[]",
              });
            },
          },
        ],
      }),
      /not named in Vite's manifest: organizer\.json/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("in the station folder the dev server serves only source files: a key named organizer.json in src gets 403", async () => {
  const src = join(APP, "src");
  const tag = `dev-server-test-${process.pid}`;
  const files = [
    join(src, `${tag}-organizer.json`),
    join(src, `${tag}-notes.md`),
  ];
  const written: string[] = [];
  const dev = await createServer({
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    logLevel: "silent",
    server: { port: await freePort(), strictPort: true },
  });
  try {
    // Stand-ins, each created with flag "wx", so an existing file is not overwritten.
    for (const file of files) {
      writeFileSync(file, `${MARKER}\n`, { flag: "wx" });
      written.push(file);
    }
    await dev.listen();
    const port = (dev.httpServer!.address() as AddressInfo).port;
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await res.text();
      return { status: res.status, served: body.includes(MARKER) };
    };
    for (const file of files) {
      const name = file.slice(src.length + 1);
      for (const path of [
        `/src/${name}`,
        `/src/${name}?raw`,
        `/src/${name}?import`,
        `/@fs${file}`,
      ])
        assert.deepEqual(await get(path), { status: 403, served: false }, path);
    }
    assert.equal((await get("/src/main.ts")).status, 200);
  } finally {
    await dev.close();
    for (const file of written) rmSync(file, { force: true });
  }
});

test("a notes.html left in the output folder fails the build, and one added after it is not served by the preview", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-build-"));
  const config = {
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    logLevel: "silent" as const,
  };
  let previewServer: Awaited<ReturnType<typeof preview>> | null = null;
  try {
    // A file already in the output folder, kept since emptyOutDir is off.
    writeFileSync(join(outDir, "notes.html"), `${MARKER}\n`);
    await assert.rejects(
      build({ ...config, build: { outDir, emptyOutDir: false } }),
      /not named in Vite's manifest: notes\.html/,
    );
    // A clean build, then the same file dropped in afterwards.
    await build({ ...config, build: { outDir, emptyOutDir: true } });
    writeFileSync(join(outDir, "notes.html"), `${MARKER}\n`);
    previewServer = await preview({
      ...config,
      build: { outDir },
      preview: { port: await freePort(), strictPort: true },
    });
    const port = (previewServer.httpServer.address() as AddressInfo).port;
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await res.text();
      return { status: res.status, body };
    };
    const notes = await get("/notes.html");
    assert.equal(notes.status, 403);
    assert.ok(!notes.body.includes(MARKER));
    assert.equal((await get("/.vite/manifest.json")).status, 403);
    const page = await get("/");
    assert.equal(page.status, 200);
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
    assert.ok(script !== undefined, "the built page names its script");
    assert.equal((await get(script)).status, 200);
  } finally {
    if (previewServer !== null)
      await new Promise<void>((resolve) =>
        previewServer!.httpServer.close(() => resolve()),
      );
    rmSync(outDir, { recursive: true, force: true });
  }
});
