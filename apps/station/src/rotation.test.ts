// E-03: the station page renders a fresh QR every 30 s.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchStationQr,
  readStationConfig,
  startRotation,
  type StationQrResponse,
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

function response(n: number): StationQrResponse {
  return {
    qr: `limen:station:v1.payload-${n}.signer.signature`,
    station: "st-front",
    session: "day-2",
    issued_at: 1000 + 30 * n,
    expires_at: 1060 + 30 * n,
    refresh_after_s: 30,
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
    expiresAt: 1150,
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
    return new Response(JSON.stringify(response(1)), { status: 200 });
  }) as typeof fetch;
  const got = await fetchStationQr(fakeFetch, "/api", {
    station: "st-front",
    token: "tok",
  });
  assert.deepEqual(got, response(1));
  assert.deepEqual(seen, [
    { url: "/api/stations/st-front/qr", auth: "Bearer tok" },
  ]);
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
