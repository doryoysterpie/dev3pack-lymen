// E-02 done test, part 2: health returns the version.
// E-03: the station display fetches a signed QR for its station in the active session.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { openDatabase } from "./db.ts";
import { seedEvent } from "./seed.ts";
import { API_VERSION, createApiServer } from "./server.ts";
import {
  stationAllowlist,
  verifyStationQr,
  type StationSigner,
} from "./station-qr.ts";
import { stationDisplayToken } from "./station-token.ts";

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const SIGNER: StationSigner = {
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
const TOKEN = "test-display-token-0123456789abcdef";
/** The credential a station's display page is given: its own token, derived from the secret. */
const displayCredential = (station: string): string =>
  stationDisplayToken(TOKEN, station);
const T = 1_795_000_000;
let clock = T;

const db = openDatabase(":memory:");
db.exec(`
  INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', ${T});
  INSERT INTO stations (id, name, created_at) VALUES ('st-side', 'Side door', ${T});
  INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-1', 'Day 1', ${T - 86400}, ${T});
  INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-2', 'Day 2', ${T}, ${T + 86400});
`);
const server = createApiServer({
  db,
  version: API_VERSION,
  stationSigner: SIGNER,
  stationDisplayToken: TOKEN,
  now: () => clock,
});
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function getQr(
  station: string,
  token: string | null = displayCredential(station),
): Promise<Response> {
  return fetch(`${base}/stations/${station}/qr`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

test("a display's credential gets its own station's QR and no other station's", async () => {
  clock = T + 100;
  const front = displayCredential("st-front");
  assert.equal((await getQr("st-front", front)).status, 200);
  const other = await getQr("st-side", front);
  assert.equal(
    other.status,
    401,
    "st-front's credential is refused for st-side",
  );
  assert.deepEqual(await other.json(), { error: "unauthorized" });
  assert.equal(
    (await getQr("st-side", displayCredential("st-side"))).status,
    200,
  );
});

test("each station's display token is the owed HMAC of its ID under the secret", () => {
  // Owed values computed with Python's hmac and hashlib, not by this code.
  assert.equal(
    stationDisplayToken(TOKEN, "st-front"),
    "lWbhFKhap4ZM9Ptol3mb5KYvWJUs8yXG84tELGGMwwQ",
  );
  assert.equal(
    stationDisplayToken(TOKEN, "st-side"),
    "L5i7tCSd7fvJ9s-_LyJQERgmCJINPvHHpemAY2XcGBY",
  );
});

test("the API version is the one services/api/package.json states", () => {
  assert.equal(API_VERSION, "0.1.0");
});

test("GET /health returns 200 with the API version and the migrated schema version", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await res.json(), {
    status: "ok",
    version: "0.1.0",
    schema_version: 3,
  });
});

test("a method other than GET on /health is refused with 405 and an Allow header", async () => {
  const res = await fetch(`${base}/health`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
  assert.deepEqual(await res.json(), { error: "method_not_allowed" });
});

test("an unknown path returns 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("the station display gets a QR for its station in the active session that verifies", async () => {
  clock = T + 100;
  const res = await getQr("st-front");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.station, "st-front");
  assert.equal(body.session, "day-2");
  assert.equal(body.issued_at, T + 100);
  assert.equal(body.expires_at, T + 160);
  // The answer carries the QR and its signed fields, and no other field.
  assert.deepEqual(Object.keys(body).sort(), [
    "expires_at",
    "issued_at",
    "qr",
    "session",
    "station",
  ]);
  const result = verifyStationQr(String(body.qr), {
    allowlist: stationAllowlist([SIGNER.publicKey]),
    expectedStation: "st-front",
    nowMs: (T + 100) * 1000,
  });
  assert.ok(result.ok);
  assert.equal(result.payload.station, "st-front");
  assert.equal(result.payload.session, "day-2");
});

test("two fetches return QRs with different nonces", async () => {
  clock = T + 100;
  const nonces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { qr } = (await (await getQr("st-front")).json()) as { qr: string };
    const result = verifyStationQr(qr, {
      allowlist: stationAllowlist([SIGNER.publicKey]),
      expectedStation: "st-front",
      nowMs: clock * 1000,
    });
    assert.ok(result.ok);
    nonces.push(result.payload.nonce);
  }
  // The nonces of the two verified payloads, not the whole QR texts, which could differ while
  // the nonce repeats.
  assert.notEqual(nonces[0], nonces[1]);
});

test("the QR endpoint refuses a request without the display token, or with a wrong one", async () => {
  clock = T + 100;
  for (const token of [
    null,
    "",
    // The secret itself, and the derived token one character off.
    TOKEN,
    `${displayCredential("st-front")}x`,
    displayCredential("st-front").slice(0, -1),
    "wrong-token-0123456789abcdef0123",
    `${TOKEN}x`,
    TOKEN.slice(0, -1),
  ]) {
    const res = await getQr("st-front", token);
    assert.equal(res.status, 401, `token ${JSON.stringify(token)}`);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  }
  const basic = await fetch(`${base}/stations/st-front/qr`, {
    headers: { authorization: `Basic ${TOKEN}` },
  });
  assert.equal(basic.status, 401);
});

test("the QR endpoint returns 404 for an unknown station and 409 outside every session", async () => {
  clock = T + 100;
  const unknown = await getQr("st-back");
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "unknown_station" });

  clock = T + 86400;
  const closed = await getQr("st-front");
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), { error: "no_active_session" });
});

test("the QR endpoint picks the session whose window holds the current time", async () => {
  clock = T - 1;
  const body = (await (await getQr("st-front")).json()) as { session: string };
  assert.equal(body.session, "day-1");
});

test("a QR issued in a session's last second expires when the session ends", async () => {
  // day-1 ends at T; the QR is issued at T - 1.
  clock = T - 1;
  const body = (await (await getQr("st-front")).json()) as {
    qr: string;
    session: string;
    expires_at: number;
  };
  assert.equal(body.session, "day-1");
  assert.equal(body.expires_at, T);
  const at = (nowMs: number) => {
    const r = verifyStationQr(body.qr, {
      allowlist: stationAllowlist([SIGNER.publicKey]),
      expectedStation: "st-front",
      nowMs,
    });
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(at(T * 1000 - 1), "ok");
  assert.equal(at(T * 1000), "expired");
  assert.equal(at(T * 1000 + 1), "expired");
  assert.equal(at((T + 59) * 1000), "expired");
  // At T itself the API has moved to day-2, and day-1's QR is already refused.
  clock = T;
  const next = (await (await getQr("st-front")).json()) as { session: string };
  assert.equal(next.session, "day-2");
});

test("no QR issued in a session verifies at or after its end, the instant the API moves to the next session", async () => {
  // day-1 ends at T and day-2 starts at T. A QR is fetched in each of day-1's last 61 seconds.
  const at = (qr: string, nowMs: number) => {
    const r = verifyStationQr(qr, {
      allowlist: stationAllowlist([SIGNER.publicKey]),
      expectedStation: "st-front",
      nowMs,
    });
    return r.ok ? "ok" : r.reason;
  };
  for (let second = T - 61; second < T; second++) {
    clock = second;
    const body = (await (await getQr("st-front")).json()) as {
      qr: string;
      session: string;
    };
    assert.equal(body.session, "day-1");
    assert.equal(
      at(body.qr, T * 1000),
      "expired",
      `issued at T - ${T - second}`,
    );
  }
  clock = T;
  const next = (await (await getQr("st-front")).json()) as { session: string };
  assert.equal(next.session, "day-2");
  // A QR whose 60 s end before its session does keeps them: it verifies at exactly 60,000 ms
  // after issue and is refused 1 ms later.
  clock = T - 61;
  const full = (await (await getQr("st-front")).json()) as {
    qr: string;
    expires_at: number;
  };
  assert.equal(full.expires_at, T - 1);
  assert.equal(at(full.qr, (T - 61) * 1000 + 60_000), "ok");
  assert.equal(at(full.qr, (T - 61) * 1000 + 60_001), "expired");
});

test("with a millisecond clock, a QR issued 100 ms before its session ends is that session's and expires at its end", async () => {
  const msServer = createApiServer({
    db,
    version: API_VERSION,
    stationSigner: SIGNER,
    stationDisplayToken: TOKEN,
    now: () => T - 1,
    nowMs: () => (T - 1) * 1000 + 900,
  });
  await new Promise<void>((resolve) =>
    msServer.listen(0, "127.0.0.1", resolve),
  );
  try {
    const url = `http://127.0.0.1:${(msServer.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/stations/st-front/qr`, {
      headers: { authorization: `Bearer ${displayCredential("st-front")}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(
      [body.session, body.issued_at, body.expires_at],
      ["day-1", T - 1, T],
    );
  } finally {
    await new Promise<void>((resolve) => msServer.close(() => resolve()));
  }
});

test("the QR endpoint refuses methods other than GET", async () => {
  const res = await fetch(`${base}/stations/st-front/qr`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("between back-to-back sessions, a QR issued 10 s before the end expires at the end, and from the end the next session's QR is served", async () => {
  // day-1 ends at T and day-2 starts at T.
  clock = T - 10;
  const before = (await (await getQr("st-front")).json()) as {
    session: string;
    expires_at: number;
  };
  assert.equal(before.session, "day-1");
  assert.equal(before.expires_at, T);
  clock = T;
  const after = (await (await getQr("st-front")).json()) as {
    session: string;
    expires_at: number;
  };
  assert.equal(after.session, "day-2");
  assert.equal(after.expires_at, T + 60);
});

test("the QR endpoint reads the clock once, after its database reads, and signs with that reading", async () => {
  // Each database read moves this clock on by 2 s, so a reading taken before a read differs
  // from one taken after it.
  let ms = (T + 100) * 1000;
  let readings = 0;
  const statement = (inner: object): object =>
    new Proxy(inner, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "get" || key === "all") ms += 2000;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const timedDb = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "prepare")
        return (sql: string) => statement(target.prepare(sql));
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  const timed = createApiServer({
    db: timedDb,
    version: API_VERSION,
    stationSigner: SIGNER,
    stationDisplayToken: TOKEN,
    now: () => {
      readings += 1;
      return Math.floor(ms / 1000);
    },
    nowMs: () => {
      readings += 1;
      return ms;
    },
  });
  await new Promise<void>((resolve) => timed.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(timed.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/stations/st-front/qr`, {
      headers: { authorization: `Bearer ${displayCredential("st-front")}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      issued_at: number;
      expires_at: number;
    };
    // Two reads (the station, then the sessions) moved the clock to T + 104 before it was read.
    assert.equal(ms, (T + 104) * 1000);
    assert.equal(readings, 1);
    assert.deepEqual([body.issued_at, body.expires_at], [T + 104, T + 164]);
  } finally {
    await new Promise<void>((resolve) => timed.close(() => resolve()));
  }
});

test("a re-seed that would shorten the session while a QR request is between its reads is refused, so the QR does not outlive the stored session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-qr-race-"));
  const file = join(dir, "limen.db");
  const apiDb = openDatabase(file);
  const seedDb = openDatabase(file);
  apiDb.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', 1);
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('s1', 'S1', 1000, 2000);
  `);
  let seed = "not run";
  const raced = createApiServer({
    db: apiDb,
    version: API_VERSION,
    stationSigner: SIGNER,
    stationDisplayToken: TOKEN,
    now: () => 1010,
    // Between its reads, the request lets a seed run on another connection. The seed's clock
    // reads 900, when s1 has not started, so its rules allow moving s1's end to 1030.
    nowMs: () => {
      try {
        seedEvent(
          seedDb,
          {
            stations: [],
            sessions: [
              { id: "s1", name: "S1", starts_at: 1000, ends_at: 1030 },
            ],
          },
          () => 900,
        );
        seed = "written";
      } catch (err) {
        seed = err instanceof Error ? err.message : String(err);
      }
      return 1010 * 1000;
    },
  });
  await new Promise<void>((resolve) => raced.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(raced.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/stations/st-front/qr`, {
      headers: { authorization: `Bearer ${displayCredential("st-front")}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { expires_at: number };
    const stored = seedDb
      .prepare("SELECT ends_at FROM sessions WHERE id = 's1'")
      .get() as { ends_at: number };
    // The seed could not take the write lock the request holds, and the QR fits the session.
    assert.match(seed, /database is locked/);
    assert.equal(stored.ends_at, 2000);
    assert.ok(body.expires_at <= stored.ends_at);
  } finally {
    await new Promise<void>((resolve) => raced.close(() => resolve()));
    apiDb.close();
    seedDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a QR request while a seed holds the write lock gets 503, not a QR from a session being changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-qr-race-"));
  const file = join(dir, "limen.db");
  const apiDb = openDatabase(file);
  const seedDb = openDatabase(file);
  apiDb.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', 1);
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('s1', 'S1', 1000, 2000);
  `);
  const locked = createApiServer({
    db: apiDb,
    version: API_VERSION,
    stationSigner: SIGNER,
    stationDisplayToken: TOKEN,
    now: () => 1010,
  });
  await new Promise<void>((resolve) => locked.listen(0, "127.0.0.1", resolve));
  seedDb.exec("BEGIN IMMEDIATE");
  try {
    const url = `http://127.0.0.1:${(locked.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/stations/st-front/qr`, {
      headers: { authorization: `Bearer ${displayCredential("st-front")}` },
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "busy" });
  } finally {
    seedDb.exec("ROLLBACK");
    await new Promise<void>((resolve) => locked.close(() => resolve()));
    apiDb.close();
    seedDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
