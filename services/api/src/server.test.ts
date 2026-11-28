// E-02 done test, part 2: health returns the version.
// E-03: the station display fetches a signed QR for its station in the active session.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { openDatabase } from "./db.ts";
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
  nowMs: () => clock * 1000,
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
    schema_version: 5,
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
  assert.equal(body.refresh_after_s, 30);
  assert.equal(body.expires_in_ms, 60_000);
  const result = verifyStationQr(String(body.qr), {
    allowlist: stationAllowlist([SIGNER.publicKey]),
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

test("with a millisecond clock the QR's time left is exact, so a QR issued 100 ms before its session ends says so", async () => {
  const msServer = createApiServer({
    db,
    version: API_VERSION,
    stationSigner: SIGNER,
    stationDisplayToken: TOKEN,
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
      [body.session, body.expires_at, body.refresh_after_s, body.expires_in_ms],
      ["day-1", T, 1, 100],
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

test("between back-to-back sessions the page is told to refresh when the old QR expires, not 30 s later", async () => {
  // day-1 ends at T and day-2 starts at T.
  clock = T - 10;
  const before = (await (await getQr("st-front")).json()) as {
    session: string;
    expires_at: number;
    refresh_after_s: number;
  };
  assert.equal(before.session, "day-1");
  assert.equal(before.expires_at, T);
  assert.equal(before.refresh_after_s, 10);
  clock = T - 1;
  assert.equal(
    ((await (await getQr("st-front")).json()) as { refresh_after_s: number })
      .refresh_after_s,
    1,
  );
  // When that refresh comes, the next session's QR is there, with the full 30 s.
  clock = T;
  const after = (await (await getQr("st-front")).json()) as {
    session: string;
    refresh_after_s: number;
  };
  assert.equal(after.session, "day-2");
  assert.equal(after.refresh_after_s, 30);
});
