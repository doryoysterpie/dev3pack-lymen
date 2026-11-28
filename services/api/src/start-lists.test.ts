// E-12: the API starts without the domain list file. It copies this service's source to a
// temporary directory with no fixtures beside it, so the bundled list file is missing, and starts
// the real entry point there.
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { TEST_STATION_DISPLAY_SECRET } from "./test-station.ts";

const SERVICE = fileURLToPath(new URL("..", import.meta.url));

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const RFC_KEYPAIR = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];

const REPORT = readFileSync(
  new URL("../../../fixtures/reports/e10-reports.json", import.meta.url),
  "utf8",
);

const TOKEN = "test-triage-token-0123456789-abcdefghij";

/** A port that was free a moment ago. The API refuses port 0, so the test picks one. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type Child = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Starts the entry point on a free port and waits for its listening line. A port taken between
 * the probe and the start makes the API exit with EADDRINUSE; that start is tried again on a
 * fresh port, up to five times.
 */
async function startApi(
  entry: string,
  env: Record<string, string>,
): Promise<{ child: Child; url: string; stderr: () => string }> {
  for (let attempt = 1; ; attempt++) {
    const child: Child = spawn(process.execPath, [entry], {
      env: { ...env, API_PORT: String(await freePort()) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(out);
          if (match?.[1]) resolve(match[1]);
        });
        child.once("exit", (code) =>
          reject(new Error(`API exited early with code ${code}: ${stderr}`)),
        );
      });
      return { child, url, stderr: () => stderr };
    } catch (err) {
      if (attempt < 5 && /EADDRINUSE/.test(stderr)) continue;
      throw err;
    }
  }
}

test("without the domain list file the API starts, /health answers, and the triage routes answer 503", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limen-lists-")));
  const service = join(dir, "services", "api");
  for (const part of ["src", "dashboard", "package.json"]) {
    cpSync(join(SERVICE, part), join(service, part), { recursive: true });
  }
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  const { child, url, stderr } = await startApi(
    join(service, "src", "index.ts"),
    {
      PATH: process.env.PATH ?? "",
      ORGANIZER_KEYPAIR_PATH: keyPath,
      DATABASE_PATH: join(dir, "limen.db"),
      TRIAGE_TOKEN: TOKEN,
      STATION_DISPLAY_TOKEN: TEST_STATION_DISPLAY_SECRET,
    },
  );
  try {
    assert.match(stderr(), /the triage domain lists did not load/);

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, "ok");

    const report = await fetch(`${url}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        (JSON.parse(REPORT) as Record<string, unknown>).drainer_device_1,
      ),
    });
    assert.deepEqual(
      [report.status, await report.json()],
      [503, { error: "triage_lists_unavailable" }],
    );
    const cases = await fetch(`${url}/cases`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.deepEqual(
      [cases.status, await cases.json()],
      [503, { error: "triage_lists_unavailable" }],
    );
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
