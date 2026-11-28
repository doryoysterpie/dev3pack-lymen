// E-03: the station page's rotation, driven with a fake clock and fake fetches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrivateKey } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { openDatabase } from "../../../services/api/src/db.ts";
import {
  API_VERSION,
  createApiServer,
} from "../../../services/api/src/server.ts";
import { stationDisplayToken } from "../../../services/api/src/station-token.ts";
import {
  fetchStationQr,
  readStationId,
  RETRY_AFTER_MS,
  startRotation,
  type StationQr,
  type StationView,
} from "./rotation.ts";

/** A fake clock: its timers run when the test advances time. */
function fakeClock(start = 0) {
  let now = start;
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
    /** Moves the clock forward without running any timer, as a slow step would. */
    jump(ms: number): void {
      now += ms;
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = Math.max(now, end);
    },
  };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Placeholder QR values injected directly into startRotation; not issued or signed by the API. */
function response(n: number): StationQr {
  return {
    qr: `limen:station:v1.payload-${n}.signer.signature`,
    station: "st-front",
    session: "day-2",
    issuedAt: 1000 + 30 * n,
    expiresAt: 1060 + 30 * n,
  };
}

/**
 * An answer for response(n), shaped like the API's but not one it would send: the QR's signer and
 * signature are placeholders, since the page does not check the signature. Its station, session,
 * issued_at and expires_at fields beside the QR may differ from the payload's; the page reads the
 * payload.
 */
function wireBody(
  n: number,
  station = "st-front",
  payloadTimes: { issuedAt: number; expiresAt: number } = response(n),
) {
  const r = { ...response(n), ...payloadTimes };
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
  };
}

test("startRotation fetches and renders injected placeholder QRs at 0 s, 30 s and 60 s", async () => {
  const clock = fakeClock();
  const fetchedAt: number[] = [];
  const shown: StationView[] = [];
  let n = 0;
  startRotation({
    fetchQr: async () => {
      fetchedAt.push(clock.now);
      return response(++n);
    },
    render: (view) => {
      shown.push(view);
    },
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
    // Fetched at 60 s: the earlier of its expires_at, 1150 s, and its 60 s window after the request
    // left, less the 5 s skew.
    deadline: 60_000 + 60_000 - 5_000,
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
    render: (view) => {
      shown.push(view);
    },
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

test("the page reads its station from the query string's ?station=", () => {
  assert.deepEqual(readStationId("?station=st-front"), { station: "st-front" });
  // A token in the query is not read.
  assert.deepEqual(readStationId("?station=st-front&token=abc"), {
    station: "st-front",
  });
  for (const search of [
    "",
    "?token=abc",
    "?station=st%20front",
    `?station=${"x".repeat(65)}`,
  ])
    assert.deepEqual(readStationId(search), {
      error: "Add ?station=<station ID> to the page address.",
    });
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

test("an answer whose QR's payload names another station, or that carries no payload, is refused", async () => {
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
    [answering(503, { error: "busy" }), "The API is busy right now."],
    [answering(503, { error: "x" }), "The API answered with status 503."],
    [answering(504), "The API cannot be reached."],
    [
      answering(200, { qr: "https://example.com/" }),
      "The API answered with something that is not a station QR.",
    ],
    [
      answering(200, { ...response(1) }),
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

test("a station's display token, as the station-token tool derives it, reaches the real API and gets that station's QR, and the secret itself is refused", async () => {
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
    const qr = await fetchStationQr(fetch, base, {
      station: "st-front",
      token: stationDisplayToken(secret, "st-front"),
    });
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

test("a fetch that does not answer is abandoned after 10 s, shown as a failure, and retried", async () => {
  const clock = fakeClock();
  const fetchedAt: number[] = [];
  const shown: StationView[] = [];
  let calls = 0;
  startRotation({
    fetchQr: (signal) => {
      fetchedAt.push(clock.now);
      calls++;
      if (calls === 2) {
        // Rejects when the rotation aborts it, and does not settle otherwise.
        return new Promise<StationQr>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
      return Promise.resolve(response(calls));
    },
    render: (view) => {
      shown.push(view);
    },
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

/**
 * A fetch that answers after `delayMs` on the fake clock with a QR whose payload gives a window of
 * `windowS` seconds, while the answer's own expires_at field claims 60 s.
 */
function payloadAnswer(
  clock: ReturnType<typeof fakeClock>,
  delayMs: number,
  windowS: number,
) {
  return (async () => {
    const body = {
      ...wireBody(1, "st-front", { issuedAt: 1000, expiresAt: 1000 + windowS }),
      expires_at: 1060,
    };
    await new Promise<void>((resolve) => clock.setTimeout(resolve, delayMs));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

test("a fetched QR whose issued_at and expires_at are 20 s apart gets the deadline 15 s after its request left, 5 s early, and the next fetch comes then", async () => {
  const clock = fakeClock();
  const fetchedAt: number[] = [];
  const deadlines: number[] = [];
  let calls = 0;
  startRotation({
    fetchQr: (signal) => {
      fetchedAt.push(clock.now);
      calls++;
      if (calls === 1)
        return Promise.resolve({
          ...response(1),
          issuedAt: 1000,
          expiresAt: 1020,
        });
      return new Promise<StationQr>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    render: (view) => {
      if (view.kind === "qr") deadlines.push(view.deadline);
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  assert.deepEqual(deadlines, [15_000]);
  await clock.advance(14_999);
  assert.deepEqual(fetchedAt, [0]);
  await clock.advance(1);
  assert.deepEqual(fetchedAt, [0, 15_000]);
});

test("with a 2 s response delay, the deadline is counted from when the request left", async () => {
  const clock = fakeClock();
  const deadlines: { at: number; deadline: number }[] = [];
  let calls = 0;
  startRotation({
    fetchQr: (signal) => {
      calls++;
      // The first answer takes 2 s, with issued_at and expires_at 10 s apart; the next fetch hangs.
      if (calls === 1)
        return new Promise<StationQr>((resolve) => {
          clock.setTimeout(
            () => resolve({ ...response(1), issuedAt: 1000, expiresAt: 1010 }),
            2000,
          );
        });
      return new Promise<StationQr>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    render: (view) => {
      if (view.kind === "qr")
        deadlines.push({ at: clock.now, deadline: view.deadline });
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  await clock.advance(2_000);
  assert.deepEqual(deadlines, [{ at: 2000, deadline: 10_000 - 5_000 }]);
});

test("a fetched QR with a 60 s window whose issued_at is 2 minutes ago is not drawn, and the next fetch waits the retry delay", async () => {
  // The page's clock reads T; the fetched QR's issued_at is T - 120 s and its window 60 s.
  const T = 1_795_000_000;
  const clock = fakeClock(T * 1000);
  const shown: string[] = [];
  let calls = 0;
  startRotation({
    fetchQr: (signal) => {
      calls++;
      if (calls === 1)
        return Promise.resolve({
          ...response(1),
          issuedAt: T - 120,
          expiresAt: T - 60,
        });
      return new Promise<StationQr>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    render: (view) => {
      shown.push(view.kind);
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  assert.deepEqual(shown, ["refreshing"]);
  // The next fetch waits the retry delay, so a station whose QRs arrive stale does not refetch in
  // a loop.
  await clock.advance(RETRY_AFTER_MS - 1);
  assert.equal(calls, 1, "no fetch before the retry delay");
  await clock.advance(1);
  assert.equal(calls, 2, "the next fetch comes after the retry delay");
});

test("the deadline and the next fetch come from the payload's times, not from the answer's other fields", async () => {
  // The answer's expires_at claims 60 s; the QR's payload gives 8 s.
  const clock = fakeClock();
  const fetchedAt: number[] = [];
  const shown: { at: number; kind: string }[] = [];
  const answer = payloadAnswer(clock, 0, 8);
  startRotation({
    fetchQr: (signal) => {
      fetchedAt.push(clock.now);
      return fetchStationQr(
        answer,
        "/api",
        { station: "st-front", token: "tok" },
        signal,
      );
    },
    render: (view) => {
      shown.push({ at: clock.now, kind: view.kind });
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await clock.advance(0);
  assert.deepEqual(shown, [{ at: 0, kind: "qr" }]);
  // The payload's window is 8 s, so the next fetch comes 5 s before it ends, at 3 s, not at the
  // 30 s rotation or by the answer's expires_at.
  await clock.advance(2_999);
  assert.deepEqual(fetchedAt, [0]);
  await clock.advance(1);
  assert.deepEqual(fetchedAt, [0, 3_000]);
});

test("a QR whose payload's window has passed when it arrives is not drawn, whatever the answer's other fields say", async () => {
  // Its payload gives a 1 s window, and it arrives 2 s after the request left; the answer's
  // expires_at claims 60 s.
  const clock = fakeClock();
  const shown: { at: number; kind: string }[] = [];
  let calls = 0;
  const late = payloadAnswer(clock, 2000, 1);
  startRotation({
    fetchQr: (signal) => {
      calls++;
      if (calls === 1)
        return fetchStationQr(
          late,
          "/api",
          { station: "st-front", token: "tok" },
          signal,
        );
      return new Promise<StationQr>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    render: (view) => {
      shown.push({ at: clock.now, kind: view.kind });
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  await clock.advance(2_000);
  assert.deepEqual(shown, [{ at: 2000, kind: "refreshing" }]);
});

test("with the station's fake clock 2 s behind the fake issuer clock at T, the deadline is T + 53 s on the station's fake clock and T + 55 s on the fake issuer clock", async () => {
  const T = 1_795_000_000;
  // Station's fake clock starts at T - 2 s; the fake issuer clock runs 2 s ahead, starting at T.
  const stationClock = fakeClock(T * 1000 - 2000);
  const issuerClockNow = () => stationClock.now + 2000;
  const deadlines: number[] = [];
  let calls = 0;
  startRotation({
    fetchQr: (signal) => {
      if (calls++ === 0) {
        const issuedAt = Math.floor(issuerClockNow() / 1000);
        return Promise.resolve({
          ...response(1),
          issuedAt,
          expiresAt: issuedAt + 60,
        });
      }
      return new Promise<StationQr>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    render: (view) => {
      if (view.kind === "qr") deadlines.push(view.deadline);
    },
    now: () => stationClock.now,
    setTimeout: stationClock.setTimeout,
    clearTimeout: stationClock.clearTimeout,
  });
  await flush();
  // On the station's fake clock: min(T + 60 s, (T - 2 s) + 60 s) - 5 s = T + 53 s.
  assert.deepEqual(deadlines, [T * 1000 + 53_000]);
  // At that deadline on the station's fake clock (T + 53 s), the fake issuer clock reads T + 55 s,
  // 5 s before expiresAt (T + 60 s) on the fake issuer clock.
  const issuerAtDeadline = deadlines[0]! + 2000;
  assert.equal(issuerAtDeadline, (T + 55) * 1000);
});

test("the next fetch is timed from the clock after the QR is drawn", async () => {
  const clock = fakeClock();
  const delays: number[] = [];
  const fetchedAt: number[] = [];
  startRotation({
    fetchQr: async () => {
      fetchedAt.push(clock.now);
      return response(1);
    },
    // Drawing takes 10 s.
    render: async (view) => {
      if (view.kind === "qr") clock.jump(10_000);
    },
    now: () => clock.now,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return clock.setTimeout(fn, ms);
    },
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  // The fetch timeout's 10 s, then the next fetch: 30 s after the request left, less the 10 s
  // the draw took.
  assert.deepEqual(delays, [10_000, 20_000]);
  await clock.advance(20_000);
  assert.deepEqual(fetchedAt, [0, 30_000]);
});

test("a QR that goes stale while it is drawn is not shown, and the next fetch waits the retry delay", async () => {
  const clock = fakeClock();
  const delays: number[] = [];
  startRotation({
    fetchQr: async () => response(1),
    // The QR's window is 60 s, so its deadline is 55 s after the request left; drawing takes 56 s.
    render: async (view) => {
      if (view.kind === "qr") clock.jump(56_000);
    },
    now: () => clock.now,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return clock.setTimeout(fn, ms);
    },
    clearTimeout: clock.clearTimeout,
  });
  await flush();
  // The fetch timeout's 10 s, then the retry delay.
  assert.deepEqual(delays, [10_000, RETRY_AFTER_MS]);
});

test("the clock-skew deadline test names which clock both T + 53 s and T + 55 s are on", () => {
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const titles = [...self.matchAll(/\ntest\("([^"]+)"/g)].map((m) => m[1]!);
  const skewTitle = titles.find((t) => t.includes("T + 53 s"));
  assert.ok(skewTitle !== undefined, "skew test title is present");
  assert.match(skewTitle, /T \+ 53 s on the station's fake clock/);
  assert.match(skewTitle, /T \+ 55 s on the fake issuer clock/);
  assert.ok(!self.includes(`T + 55 s ${"relative to T"}`));
});
