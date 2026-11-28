// E-03: the station page renders a fresh QR every 30 s.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { openDatabase } from "../../../services/api/src/db.ts";
import {
  API_VERSION,
  createApiServer,
} from "../../../services/api/src/server.ts";
import { stationLink } from "../../../services/api/src/station-link.ts";
import {
  fetchStationQr,
  fragmentParam,
  readStationConfig,
  startRotation,
  type StationQr,
  type StationView,
} from "./rotation.ts";

/** A fake clock: timers run only when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    get now() {
      return now;
    },
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
    },
  };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function response(n: number): StationQr {
  return {
    qr: `limen:station:v1.payload-${n}.signer.signature`,
    station: "st-front",
    session: "day-2",
    issuedAt: 1000 + 30 * n,
    expiresAt: 1060 + 30 * n,
    refreshAfterS: 30,
    expiresInMs: 60_000,
  };
}

/** The API's answer for response(n): its QR text carries the payload the page reads. */
function wireBody(n: number, station = "st-front") {
  const r = response(n);
  const payload = Buffer.from(
    JSON.stringify({
      station,
      session: r.session,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      issued_at: r.issuedAt,
      expires_at: r.expiresAt,
    }),
  ).toString("base64url");
  return {
    qr: `limen:station:v1.${payload}.signer.signature`,
    station: "st-front",
    session: r.session,
    issued_at: r.issuedAt,
    expires_at: r.expiresAt,
    refresh_after_s: r.refreshAfterS,
    expires_in_ms: r.expiresInMs,
  };
}

test("the display shows a fresh QR from the API at 0 s, 30 s and 60 s", async () => {
  const clock = fakeClock();
  const fetchedAt: number[] = [];
  const shown: StationView[] = [];
  let n = 0;
  startRotation({
    fetchQr: async () => {
      fetchedAt.push(clock.now);
      return response(++n);
    },
    render: (view) => shown.push(view),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  assert.deepEqual(fetchedAt, [0]);
  await clock.advance(29_999);
  assert.deepEqual(fetchedAt, [0], "no fetch before 30 s");
  await clock.advance(1);
  await clock.advance(30_000);
  assert.deepEqual(fetchedAt, [0, 30_000, 60_000]);
  assert.deepEqual(
    shown.map((v) => (v.kind === "qr" ? v.qr : v.kind)),
    [response(1).qr, response(2).qr, response(3).qr],
  );
  assert.deepEqual(shown[2], {
    kind: "qr",
    qr: response(3).qr,
    station: "st-front",
    session: "day-2",
    issuedAt: 1090,
    expiresAt: 1150,
    refreshAfterS: 30,
    expiresInMs: 60_000,
  });
});

test("a failed fetch clears the QR, shows why, and retries after 5 s", async () => {
  const clock = fakeClock();
  const fetchedAt: number[] = [];
  const shown: StationView[] = [];
  let calls = 0;
  startRotation({
    fetchQr: async () => {
      fetchedAt.push(clock.now);
      calls++;
      if (calls === 2) throw new Error("The API cannot be reached.");
      return response(calls);
    },
    render: (view) => shown.push(view),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  await clock.advance(30_000);
  assert.deepEqual(shown[1], {
    kind: "error",
    message: "The API cannot be reached.",
  });
  await clock.advance(4_999);
  assert.deepEqual(fetchedAt, [0, 30_000]);
  await clock.advance(1);
  assert.deepEqual(fetchedAt, [0, 30_000, 35_000]);
  assert.equal(shown[2]?.kind, "qr");
});

test("stop ends the rotation", async () => {
  const clock = fakeClock();
  let calls = 0;
  const rotation = startRotation({
    fetchQr: async () => response(++calls),
    render: () => {},
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  rotation.stop();
  await clock.advance(120_000);
  assert.equal(calls, 1);
});

test("the page reads its station from ?station= and its token from #token=", () => {
  assert.deepEqual(
    readStationConfig("http://localhost:5173/?station=st-front#token=abc"),
    {
      station: "st-front",
      token: "abc",
    },
  );
  assert.deepEqual(readStationConfig("http://localhost:5173/#token=abc"), {
    error: "Add ?station=<station ID> to the page address.",
  });
  assert.deepEqual(
    readStationConfig("http://localhost:5173/?station=st%20front#token=abc"),
    {
      error: "Add ?station=<station ID> to the page address.",
    },
  );
  assert.deepEqual(
    readStationConfig("http://localhost:5173/?station=st-front"),
    {
      error: "Add #token=<display token> to the page address.",
    },
  );
});

test("one fetch asks the API for the station's QR with the token and returns its answer", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(wireBody(1)), { status: 200 });
  }) as typeof fetch;
  const got = await fetchStationQr(fakeFetch, "/api", {
    station: "st-front",
    token: "tok",
  });
  // What the page shows is read from the QR's payload, not the answer's other fields.
  assert.deepEqual(got, { ...response(1), qr: wireBody(1).qr });
  assert.deepEqual(seen, [
    { url: "/api/stations/st-front/qr", auth: "Bearer tok" },
  ]);
});

test("an answer whose QR is signed for another station, or carries no payload, is refused", async () => {
  const config = { station: "st-front", token: "tok" };
  const answering = (body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
      })) as unknown as typeof fetch;
  await assert.rejects(
    fetchStationQr(answering(wireBody(1, "st-side")), "/api", config),
    { message: "The API sent a QR for another station." },
  );
  await assert.rejects(
    fetchStationQr(
      answering({ ...wireBody(1), qr: response(1).qr }),
      "/api",
      config,
    ),
    { message: "The API answered with something that is not a station QR." },
  );
});

test("each failed fetch becomes the owed message for the screen", async () => {
  const config = { station: "st-front", token: "tok" };
  const answering = (status: number, body: unknown = { error: "x" }) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  const cases: [typeof fetch, string][] = [
    [answering(401), "The API refused the display token."],
    [answering(404), "The API does not know this station."],
    [answering(409), "No session is open right now."],
    [answering(500), "The API answered with status 500."],
    [answering(502), "The API cannot be reached."],
    [answering(503), "The API cannot be reached."],
    [answering(504), "The API cannot be reached."],
    [
      answering(200, { qr: "https://example.com/" }),
      "The API answered with something that is not a station QR.",
    ],
    [
      answering(200, { ...response(1), refresh_after_s: 0 }),
      "The API answered with something that is not a station QR.",
    ],
    [
      (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      "The API cannot be reached.",
    ],
  ];
  for (const [fetchFn, message] of cases) {
    await assert.rejects(fetchStationQr(fetchFn, "/api", config), { message });
  }
});

test("a display token with +, / and = is read from #token= exactly as written", () => {
  const token = "ab+cd/ef+gh==";
  assert.deepEqual(
    readStationConfig(`http://localhost:5173/?station=st-front#token=${token}`),
    {
      station: "st-front",
      token,
    },
  );
  assert.equal(fragmentParam("#token=a%2Bb%2Fc%3D", "token"), "a+b/c=");
  assert.equal(fragmentParam("#x=1&token=a+b", "token"), "a+b");
  assert.equal(fragmentParam("#token=a=b=", "token"), "a=b=");
  assert.equal(fragmentParam("#other=1", "token"), null);
});

test("a station link from the link tool reaches the real API and gets that station's QR, and the secret itself is refused", async () => {
  // RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
  const signer = {
    publicKey: Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    ),
    privateKey: createPrivateKey({
      key: Buffer.from(
        "302e020100300506032b657004220420" +
          "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "hex",
      ),
      format: "der",
      type: "pkcs8",
    }),
  };
  // The API's secret, as `openssl rand -base64 32` makes one, with "+", "/" and "=".
  const secret = "q+Wr/9Kp+Zt0LmN/xYv2+AbC/dEf=GhIjKlMnOpQ==";
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', 1);
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-2', 'Day 2', 1795000000, 1795086400);
  `);
  const server = createApiServer({
    db,
    version: API_VERSION,
    stationSigner: signer,
    stationDisplayToken: secret,
    now: () => 1795000100,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = readStationConfig(stationLink(secret, "st-front"));
    assert.ok(!("error" in config));
    const qr = await fetchStationQr(fetch, base, config);
    assert.equal(qr.station, "st-front");
    assert.ok(qr.qr.startsWith("limen:station:v1."));
    // A page given the secret itself, rather than its station's token, is refused.
    await assert.rejects(
      fetchStationQr(fetch, base, { station: "st-front", token: secret }),
      {
        message: "The API refused the display token.",
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a fetch that never answers is abandoned after 10 s, shown as a failure, and retried", async () => {
  const clock = fakeClock();
  const fetchedAt: number[] = [];
  const shown: StationView[] = [];
  let calls = 0;
  startRotation({
    fetchQr: (signal) => {
      fetchedAt.push(clock.now);
      calls++;
      if (calls === 2) {
        // Never settles on its own; only the rotation's abort ends the wait.
        return new Promise<StationQr>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
      return Promise.resolve(response(calls));
    },
    render: (view) => shown.push(view),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  await clock.advance(40_000);
  assert.deepEqual(
    shown.map((v) => v.kind),
    ["qr", "error"],
  );
  assert.deepEqual(shown[1], {
    kind: "error",
    message: "The API did not answer in time.",
  });
  await clock.advance(5_000);
  assert.deepEqual(fetchedAt, [0, 30_000, 45_000]);
  assert.equal(shown.at(-1)?.kind, "qr");
});

test("a QR that outlives its lifetime on screen is cleared and the page says it is refreshing", async () => {
  const clock = fakeClock();
  const shown: StationView[] = [];
  let calls = 0;
  startRotation({
    // The API asks for a refresh only at 60 s, and that fetch then hangs.
    fetchQr: (signal) => {
      calls++;
      if (calls === 1)
        return Promise.resolve({ ...response(1), refreshAfterS: 60 });
      return new Promise<StationQr>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    render: (view) => shown.push(view),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  await clock.advance(59_999);
  assert.deepEqual(
    shown.map((v) => v.kind),
    ["qr"],
  );
  await clock.advance(1);
  assert.deepEqual(
    shown.map((v) => v.kind),
    ["qr", "refreshing"],
  );
  await clock.advance(10_000);
  assert.deepEqual(
    shown.map((v) => v.kind),
    ["qr", "refreshing", "error"],
  );
});

test("with a 2 s response delay, a shown QR is cleared at its server expiry, not 2 s late", async () => {
  const clock = fakeClock();
  const shown: { at: number; kind: string }[] = [];
  let calls = 0;
  startRotation({
    fetchQr: (signal) => {
      calls++;
      // The first answer takes 2 s and has 10 s left as it leaves the API; the next one hangs.
      if (calls === 1)
        return new Promise<StationQr>((resolve) => {
          clock.setTimeout(
            () => resolve({ ...response(1), expiresInMs: 10_000 }),
            2000,
          );
        });
      return new Promise<StationQr>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    render: (view) => shown.push({ at: clock.now, kind: view.kind }),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  await clock.advance(9_999);
  assert.deepEqual(shown, [{ at: 2000, kind: "qr" }]);
  await clock.advance(1);
  assert.deepEqual(shown, [
    { at: 2000, kind: "qr" },
    { at: 10_000, kind: "refreshing" },
  ]);
});
