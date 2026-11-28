// E-02: start-up. A missing or unreadable organizer key file stops the API with one clear line
// on stderr and exit code 1, not a stack trace, and no line carries ORGANIZER_KEYPAIR_PATH's value
// or key material. A good key file starts it and health answers.
import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { listenUrl, parsePort } from "./index.ts";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const RFC_KEYPAIR = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];

const UNSET_LINE =
  "limen api: ORGANIZER_KEYPAIR_PATH is not set. Point it at the organizer keypair file (see .env.example).\n";

function runEntry(
  env: Record<string, string>,
  entry: string = ENTRY,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "limen-start-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("start-up with ORGANIZER_KEYPAIR_PATH unset exits 1 with one line naming the variable", () => {
  assert.deepEqual(runEntry({}), { status: 1, stdout: "", stderr: UNSET_LINE });
});

test("start-up with a missing key file exits 1 with one line naming the variable and ENOENT, not the path", () => {
  const missing = join(tmpdir(), "limen-no-such-dir", "organizer.json");
  assert.deepEqual(runEntry({ ORGANIZER_KEYPAIR_PATH: missing }), {
    status: 1,
    stdout: "",
    stderr:
      "limen api: The file ORGANIZER_KEYPAIR_PATH names cannot be read (ENOENT).\n",
  });
});

test(
  "start-up with an unreadable key file exits 1 with one line naming the variable and EACCES",
  { skip: process.getuid?.() === 0 ? "root ignores file modes" : false },
  () => {
    withTempDir((dir) => {
      const path = join(dir, "organizer.json");
      writeFileSync(path, JSON.stringify(RFC_KEYPAIR));
      chmodSync(path, 0o000);
      try {
        assert.deepEqual(runEntry({ ORGANIZER_KEYPAIR_PATH: path }), {
          status: 1,
          stdout: "",
          stderr:
            "limen api: The file ORGANIZER_KEYPAIR_PATH names cannot be read (EACCES).\n",
        });
      } finally {
        chmodSync(path, 0o600);
      }
    });
  },
);

test("start-up with the keypair JSON in ORGANIZER_KEYPAIR_PATH prints no byte of it", () => {
  const json = JSON.stringify(RFC_KEYPAIR);
  const { status, stdout, stderr } = runEntry({ ORGANIZER_KEYPAIR_PATH: json });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    "limen api: ORGANIZER_KEYPAIR_PATH holds what looks like key material, not a file path. Put the keypair in a file outside git and set the variable to that file's path.\n",
  );
  // No digit at all reaches stderr, so no byte value of the key can.
  assert.ok(!/[0-9]/.test(stderr));
  assert.ok(!stderr.includes(json));
});

test("start-up through a symlinked file or directory runs, rather than exiting 0 in silence", () => {
  withTempDir((dir) => {
    const linkFile = join(dir, "limen-api.ts");
    symlinkSync(ENTRY, linkFile);
    const linkDir = join(dir, "src-link");
    symlinkSync(dirname(ENTRY), linkDir);
    for (const entry of [linkFile, join(linkDir, "index.ts")]) {
      assert.deepEqual(
        runEntry({}, entry),
        { status: 1, stdout: "", stderr: UNSET_LINE },
        entry,
      );
    }
  });
});

test("API_PORT is 8787 when unset or empty, and otherwise an integer from 1 to 65535", () => {
  assert.equal(parsePort(undefined), 8787);
  assert.equal(parsePort(""), 8787);
  assert.equal(parsePort("1"), 1);
  assert.equal(parsePort("8080"), 8080);
  assert.equal(parsePort("65535"), 65535);
  for (const value of [
    " ",
    "0",
    "65536",
    "-1",
    "80a",
    "1e3",
    "0x50",
    " 80",
    "99999",
  ]) {
    assert.throws(
      () => parsePort(value),
      { message: "API_PORT must be an integer from 1 to 65535." },
      JSON.stringify(value),
    );
  }
});

test("start-up with an API_PORT of only spaces exits 1 with one line, rather than binding a random port", () => {
  withTempDir((dir) => {
    const keyPath = join(dir, "organizer.json");
    writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
    assert.deepEqual(
      runEntry({ ORGANIZER_KEYPAIR_PATH: keyPath, API_PORT: " " }),
      {
        status: 1,
        stdout: "",
        stderr: "limen api: API_PORT must be an integer from 1 to 65535.\n",
      },
    );
  });
});

test("the printed address brackets an IPv6 host, so it parses as a URL", () => {
  assert.equal(listenUrl("::1", 8787), "http://[::1]:8787");
  assert.equal(new URL(listenUrl("::1", 8787)).hostname, "[::1]");
  assert.equal(listenUrl("127.0.0.1", 8787), "http://127.0.0.1:8787");
  assert.equal(listenUrl("localhost", 80), "http://localhost:80");
});

/** What Node hands a program for API_PORT and API_HOST when it loads `text` as a .env file. */
function envFileValues(text: string): {
  API_PORT: string | null;
  API_HOST: string | null;
} {
  return withTempDir((dir) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, text);
    const seen = spawnSync(
      process.execPath,
      [
        `--env-file=${envFile}`,
        "-e",
        "process.stdout.write(JSON.stringify({ API_PORT: process.env.API_PORT ?? null, API_HOST: process.env.API_HOST ?? null }))",
      ],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
    );
    return JSON.parse(seen.stdout) as {
      API_PORT: string | null;
      API_HOST: string | null;
    };
  });
}

test("an API_PORT line in .env reaches the API as Node reads it, and gives 8787 only when that is empty", () => {
  const example = readFileSync(
    new URL("../../../.env.example", import.meta.url),
    "utf8",
  );
  assert.equal(example.split("\nAPI_PORT=\n").length, 2);
  const cases: [string, string, string | null, string | null][] = [
    ["empty, as .env.example ships it", "API_PORT=\nAPI_HOST=\n", "", ""],
    ["spaces on the last line", "API_PORT=   \n", "", null],
    ["a space, then blank lines", "API_PORT= \n\n\n", "", null],
    [
      "spaces in .env.example, where a comment follows",
      example.replace("\nAPI_PORT=\n", "\nAPI_PORT=   \n"),
      "",
      "",
    ],
    ["spaces in double quotes", 'API_PORT="   "\nAPI_HOST=\n', "   ", ""],
    ["a space in single quotes", "API_PORT=' '\nAPI_HOST=\n", " ", ""],
    [
      "spaces, then a setting",
      "API_PORT=   \nAPI_HOST=127.0.0.1\n",
      "API_HOST=127.0.0.1",
      null,
    ],
    [
      "a space, a blank line, then a setting",
      "API_PORT= \n\nAPI_HOST=\n",
      "API_HOST=",
      null,
    ],
  ];
  for (const [name, text, port, host] of cases) {
    assert.deepEqual(
      envFileValues(text),
      { API_PORT: port, API_HOST: host },
      name,
    );
    if (port === "") assert.equal(parsePort(port), 8787, name);
    else
      assert.throws(
        () => parsePort(port ?? undefined),
        { message: "API_PORT must be an integer from 1 to 65535." },
        name,
      );
  }
});

test("start-up from a .env line that Node hands over as spaces or as the next line exits 1 with one line", () => {
  withTempDir((dir) => {
    const keyPath = join(dir, "organizer.json");
    writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
    for (const line of [
      'API_PORT="   "\n',
      "API_PORT=   \nAPI_HOST=127.0.0.1\n",
    ]) {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, line);
      const result = spawnSync(
        process.execPath,
        [`--env-file=${envFile}`, ENTRY],
        {
          env: {
            PATH: process.env.PATH ?? "",
            ORGANIZER_KEYPAIR_PATH: keyPath,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.deepEqual(
        { status: result.status, stdout: result.stdout, stderr: result.stderr },
        {
          status: 1,
          stdout: "",
          stderr: "limen api: API_PORT must be an integer from 1 to 65535.\n",
        },
        JSON.stringify(line),
      );
    }
  });
});

// The start-up line names the version in package.json, read here rather than written in, so a
// version change fails the health check below instead of leaving the wait without its line.
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const LISTENING = new RegExp(
  `^limen api ${PACKAGE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} listening on (http://127\\.0\\.0\\.1:\\d+)\n`,
);
/** How long one start may take before the test stops the API and fails, rather than hang. */
const START_LIMIT_MS = 15_000;

/**
 * Starts the API on a port that was free a moment ago. If something takes that port first, the
 * API exits with EADDRINUSE, and the start is tried again on a fresh port, up to five times. A
 * start that prints no start-up line within START_LIMIT_MS is stopped and fails.
 */
async function startOnFreePort(
  env: Record<string, string>,
  choosePort: () => Promise<number> = freePort,
): Promise<{
  child: ChildProcessWithoutNullStreams;
  url: string;
  port: number;
  attempts: number;
}> {
  for (let attempt = 1; ; attempt++) {
    const port = await choosePort();
    const child = spawn(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH ?? "", ...env, API_PORT: String(port) },
    });
    const started = await new Promise<{ url: string } | { exit: string }>(
      (resolve) => {
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => (err += chunk));
        const timer = setTimeout(() => {
          child.kill();
          resolve({
            exit: `no start-up line within ${START_LIMIT_MS} ms: ${out}${err}`,
          });
        }, START_LIMIT_MS);
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
          const match = LISTENING.exec(out);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve({ url: match[1] });
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ exit: `code ${code}: ${err}` });
        });
      },
    );
    if ("url" in started)
      return { child, url: started.url, port, attempts: attempt };
    if (!started.exit.includes("EADDRINUSE") || attempt === 5) {
      throw new Error(`API did not start: ${started.exit}`);
    }
  }
}

test("start-up with a good key file serves health with the API version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-start-"));
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  const { child, url, port } = await startOnFreePort({
    ORGANIZER_KEYPAIR_PATH: keyPath,
    DATABASE_PATH: join(dir, "limen.db"),
  });
  try {
    assert.equal(url, `http://127.0.0.1:${port}`);
    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ok",
      version: "0.1.0",
      schema_version: 2,
    });
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a port taken between the probe and the start is retried rather than failing the test", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-start-"));
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  // Another listener holds the first port handed out, as a parallel test might.
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const held = (blocker.address() as AddressInfo).port;
  const ports = [held];
  try {
    const { child, port, attempts } = await startOnFreePort(
      { ORGANIZER_KEYPAIR_PATH: keyPath, DATABASE_PATH: join(dir, "limen.db") },
      async () => ports.shift() ?? freePort(),
    );
    child.kill();
    assert.equal(attempts, 2, "the first start hit EADDRINUSE and was retried");
    assert.notEqual(port, held);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
