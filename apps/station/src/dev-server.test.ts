// E-03: the station page's dev server must not serve a station link file, which holds a
// display token. The test starts Vite with this app's own vite.config.ts, puts a link file in
// the repository's .station-links/ folder, where the docs once said to write one, and owes that
// no request reaches it: by /@fs/ path, with ?raw or ?import&raw, or from another page on
// localhost.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

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

test("the dev server does not serve a link file in the repository's .station-links folder", async () => {
  const dir = join(REPO, ".station-links");
  const hadDir = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  const name = `dev-server-test-${process.pid}.url`;
  const file = join(dir, name);
  writeFileSync(
    file,
    `http://127.0.0.1:5173/?station=st-front#token=${MARKER}\n`,
  );
  const server = await createServer({
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    logLevel: "silent",
    server: { port: await freePort(), strictPort: true },
  });
  try {
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;
    for (const path of [
      `/@fs${file}`,
      `/@fs${file}?raw`,
      `/@fs${file}?import&raw`,
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { origin: "http://localhost:8081" },
      });
      const body = await res.text();
      assert.ok(
        res.status === 403 || res.status === 404,
        `${path} answered ${res.status}`,
      );
      assert.ok(!body.includes(MARKER), `${path} served the link file`);
    }
  } finally {
    await server.close();
    rmSync(file, { force: true });
    if (!hadDir) rmSync(dir, { recursive: true, force: true });
  }
});

test("the dev server serves nothing outside the station app and its dependencies: no key, database or repository file", async () => {
  // Uniquely named stand-ins where the repository keeps secrets and data, each written only if
  // absent (flag "wx") and removed afterwards; a real key file is never read, written or removed.
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
