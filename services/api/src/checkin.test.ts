// E-05 done test, backend half, prep build: a second check-in in the same session is refused with
// the owed reason; an expired window is refused; a fresh wallet with no registration binding is
// refused. E-07 and E-06 are stand-ins here (see below) until those units land; the done test
// is rerun against the real code before E-05 is READY.
import assert from "node:assert/strict";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  checkIn,
  checkinMessage,
  type CheckinDeps,
  type CheckinRegistrations,
} from "./checkin.ts";
import { openDatabase } from "./db.ts";
import {
  API_VERSION,
  createApiServer,
  MAX_CHECKIN_BODY_BYTES,
} from "./server.ts";
import {
  issueStationQr,
  stationAllowlist,
  type StationSigner,
} from "./station-qr.ts";

// RFC 8032 section 7.1, TEST 1 and TEST 2: published Ed25519 test vectors, not real keys.
function rfcSigner(seedHex: string, publicHex: string): StationSigner {
  return {
    publicKey: Buffer.from(publicHex, "hex"),
    privateKey: createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(seedHex, "hex"),
      ]),
      format: "der",
      type: "pkcs8",
    }),
  };
}
const ORGANIZER = rfcSigner(
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
);
const STRANGER = rfcSigner(
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
);
const T = 1_795_000_000;

interface Wallet {
  readonly address: string;
  readonly key: Uint8Array;
  readonly privateKey: KeyObject;
}

function wallet(address: string): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  );
  return { address, key, privateKey };
}

/**
 * Stands in for E-07 until it lands: wallet addresses map to keys through a table, and binding
 * follows E-07's rules on the real registrations table (one wallet per registration).
 */
function standInRegistrations(
  db: DatabaseSync,
  wallets: Wallet[],
): CheckinRegistrations {
  const keys = new Map(wallets.map((w) => [w.address, w.key]));
  return {
    walletKey: (address) => keys.get(address) ?? null,
    bindingOf: (address) =>
      (
        db
          .prepare("SELECT reg_hash FROM registrations WHERE wallet = ?")
          .get(address) as { reg_hash: string } | undefined
      )?.reg_hash ?? null,
    bind: (id, address, now) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
        return { ok: false, reason: "invalid_registration_id" };
      const regHash = `hash:${id.toUpperCase()}`;
      const row = db
        .prepare("SELECT wallet FROM registrations WHERE reg_hash = ?")
        .get(regHash) as { wallet: string | null } | undefined;
      if (row === undefined)
        return { ok: false, reason: "unknown_registration" };
      if (row.wallet === address) return { ok: true, regHash };
      if (row.wallet !== null)
        return { ok: false, reason: "registration_bound_to_other_wallet" };
      db.prepare(
        "UPDATE registrations SET wallet = ?, bound_at = ? WHERE reg_hash = ?",
      ).run(address, now, regHash);
      return { ok: true, regHash };
    },
  };
}

/** Stands in for E-06 until it lands: records each mint and can be made to fail. */
function recordingMinter() {
  const calls: { wallet: string; details: unknown }[] = [];
  let failNext = false;
  return {
    calls,
    failNextMint: () => {
      failNext = true;
    },
    minter: {
      mint: async (
        address: string,
        details: { station: string; session: string; checkedInAt: number },
      ) => {
        calls.push({ wallet: address, details });
        if (failNext) {
          failNext = false;
          throw new Error("devnet unavailable");
        }
        return {
          mint: `mint-${calls.length}`,
          signature: `sig-${calls.length}`,
        };
      },
    },
  };
}

function setup() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', ${T});
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-2', 'Day 2', ${T - 3600}, ${T + 3600});
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-3', 'Day 3', ${T + 3600}, ${T + 7200});
    INSERT INTO registrations (reg_hash) VALUES ('hash:LMN-0001'), ('hash:LMN-0002');
  `);
  const alice = wallet("wallet-alice");
  const bob = wallet("wallet-bob");
  const fresh = wallet("wallet-fresh");
  const minting = recordingMinter();
  const deps: CheckinDeps = {
    db,
    allowlist: stationAllowlist([ORGANIZER.publicKey]),
    registrations: standInRegistrations(db, [alice, bob, fresh]),
    minter: minting.minter,
  };
  return { db, deps, alice, bob, fresh, minting };
}

/** A check-in request as the app would build it: a fresh station QR, signed by the wallet. */
function request(
  w: Wallet,
  registrationId: string | null,
  opts: { issuedAt?: number; session?: string; signer?: StationSigner } = {},
) {
  const { text, payload } = issueStationQr({
    station: "st-front",
    session: opts.session ?? "day-2",
    now: opts.issuedAt ?? T,
    signer: opts.signer ?? ORGANIZER,
  });
  const message = checkinMessage({
    ...payload,
    wallet: w.address,
    registrationId,
  });
  return {
    qr: text,
    wallet: w.address,
    registration_id: registrationId,
    signature: sign(null, Buffer.from(message, "utf8"), w.privateKey).toString(
      "base64",
    ),
  };
}

/** checkIn at Unix time `seconds`, which may hold a fraction; checkIn itself takes milliseconds. */
const checkInAt = (d: CheckinDeps, body: unknown, seconds: number) =>
  checkIn(d, body, Math.round(seconds * 1000));

const checkinCount = (db: DatabaseSync) =>
  (db.prepare("SELECT count(*) AS n FROM checkins").get() as { n: number }).n;

test("the wallet signs this exact check-in message", () => {
  assert.equal(
    checkinMessage({
      station: "st-front",
      session: "day-2",
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      wallet: "wallet-alice",
      registrationId: "LMN-0001",
    }),
    "limen check-in v1\nstation: st-front\nsession: day-2\nnonce: AAECAwQFBgcICQoLDA0ODw\nwallet: wallet-alice\nregistration: LMN-0001",
  );
  assert.ok(
    checkinMessage({
      station: "s",
      session: "t",
      nonce: "n",
      wallet: "w",
      registrationId: null,
    }).endsWith("\nregistration: "),
  );
});

test("a first check-in binds the registration, mints once and records the pass", async () => {
  const { db, deps, alice, minting } = setup();
  const outcome = await checkInAt(deps, request(alice, "LMN-0001"), T + 5);
  assert.deepEqual(outcome, {
    status: 201,
    body: {
      status: "checked_in",
      station: "st-front",
      session: "day-2",
      mint: "mint-1",
      signature: "sig-1",
    },
  });
  assert.deepEqual(minting.calls, [
    {
      wallet: "wallet-alice",
      details: { station: "st-front", session: "day-2", checkedInAt: T + 5 },
    },
  ]);
  assert.deepEqual(
    {
      ...(db
        .prepare(
          "SELECT session_id, station_id, reg_hash, wallet, mint FROM checkins",
        )
        .get() as object),
    },
    {
      session_id: "day-2",
      station_id: "st-front",
      reg_hash: "hash:LMN-0001",
      wallet: "wallet-alice",
      mint: "mint-1",
    },
  );
});

test("E-05 done test: a second check-in in the same session is refused as already_checked_in", async () => {
  const { db, deps, alice, minting } = setup();
  assert.equal(
    (await checkInAt(deps, request(alice, "LMN-0001"), T + 5)).status,
    201,
  );
  // Again with the registration ID, and again relying on the binding alone, on fresh QRs.
  for (const registrationId of ["LMN-0001", null]) {
    const again = await checkInAt(
      deps,
      request(alice, registrationId, { issuedAt: T + 40 }),
      T + 45,
    );
    assert.deepEqual(again, {
      status: 409,
      body: { error: "already_checked_in" },
    });
  }
  assert.equal(minting.calls.length, 1, "no second pass is minted");
  assert.equal(checkinCount(db), 1);
  // The next session is a new check-in.
  const nextSession = await checkInAt(
    deps,
    request(alice, null, { issuedAt: T + 3700, session: "day-3" }),
    T + 3705,
  );
  assert.equal(nextSession.status, 201);
});

test("E-05 done test: a check-in on a QR older than 60 s is refused as station_qr_expired", async () => {
  const { db, deps, alice, minting } = setup();
  const req = request(alice, "LMN-0001", { issuedAt: T });
  assert.deepEqual(await checkInAt(deps, req, T + 61), {
    status: 400,
    body: { error: "station_qr_expired" },
  });
  assert.equal(minting.calls.length, 0);
  assert.equal(checkinCount(db), 0);
  // Nothing was bound either: the window check comes before the registration.
  assert.equal(deps.registrations.bindingOf(alice.address), null);
  // Measured to the millisecond: half a second past the window is refused too.
  assert.deepEqual(await checkInAt(deps, req, T + 60.5), {
    status: 400,
    body: { error: "station_qr_expired" },
  });
  // The same request inside the window succeeds, so the window is what refused it.
  assert.equal((await checkInAt(deps, req, T + 60)).status, 201);
});

test("E-05 done test: a fresh wallet with no registration binding is refused as no_registration_binding", async () => {
  const { db, deps, fresh, minting } = setup();
  assert.deepEqual(await checkInAt(deps, request(fresh, null), T + 5), {
    status: 403,
    body: { error: "no_registration_binding" },
  });
  assert.equal(minting.calls.length, 0);
  assert.equal(checkinCount(db), 0);
});

test("a registration already bound to another wallet is refused, and nothing is minted", async () => {
  const { deps, alice, bob, minting } = setup();
  assert.equal(
    (await checkInAt(deps, request(alice, "LMN-0001"), T + 5)).status,
    201,
  );
  assert.deepEqual(await checkInAt(deps, request(bob, "LMN-0001"), T + 6), {
    status: 403,
    body: { error: "registration_bound_to_other_wallet" },
  });
  assert.deepEqual(await checkInAt(deps, request(bob, "LMN-9999"), T + 7), {
    status: 403,
    body: { error: "unknown_registration" },
  });
  assert.equal(minting.calls.length, 1);
});

test("a signature that is not the wallet's over this exact message is refused", async () => {
  const { deps, alice, bob, minting } = setup();
  // Signed by another wallet's key.
  const forged = { ...request(bob, "LMN-0001"), wallet: alice.address };
  assert.deepEqual(await checkInAt(deps, forged, T + 5), {
    status: 401,
    body: { error: "bad_wallet_signature" },
  });
  // Signed for one registration ID, sent with another.
  const swapped = {
    ...request(alice, "LMN-0001"),
    registration_id: "LMN-0002",
  };
  assert.deepEqual(await checkInAt(deps, swapped, T + 5), {
    status: 401,
    body: { error: "bad_wallet_signature" },
  });
  assert.equal(minting.calls.length, 0);
});

test("a QR from a key off the allowlist, or a closed session, is refused before any binding", async () => {
  const { deps, alice } = setup();
  assert.deepEqual(
    await checkInAt(
      deps,
      request(alice, "LMN-0001", { signer: STRANGER }),
      T + 5,
    ),
    {
      status: 400,
      body: { error: "station_qr_invalid", reason: "signer_not_allowlisted" },
    },
  );
  // Issued 20 s before day-2 ends, used 10 s after: the QR is still in its window, the session is not.
  const late = request(alice, "LMN-0001", { issuedAt: T + 3580 });
  assert.deepEqual(await checkInAt(deps, late, T + 3610), {
    status: 409,
    body: { error: "session_closed" },
  });
  assert.equal(deps.registrations.bindingOf(alice.address), null);
});

test("a failed mint undoes the check-in, so the participant can try again", async () => {
  const { db, deps, alice, minting } = setup();
  minting.failNextMint();
  assert.deepEqual(await checkInAt(deps, request(alice, "LMN-0001"), T + 5), {
    status: 502,
    body: { error: "mint_failed" },
  });
  assert.equal(checkinCount(db), 0);
  // The binding stays, so the retry needs no registration ID.
  const retry = await checkInAt(
    deps,
    request(alice, null, { issuedAt: T + 10 }),
    T + 12,
  );
  assert.equal(retry.status, 201);
  assert.equal(minting.calls.length, 2);
});

test("a malformed request is refused by field", async () => {
  const { deps, alice } = setup();
  const good = request(alice, "LMN-0001");
  const cases: [unknown, string][] = [
    [null, "body"],
    [[good], "body"],
    [{ ...good, extra: 1 }, "extra"],
    [{ ...good, qr: "" }, "qr"],
    [{ ...good, wallet: "wallet-alice\nstation: other" }, "wallet"],
    [{ ...good, wallet: "wallet-unknown" }, "wallet"],
    [{ ...good, registration_id: 7 }, "registration_id"],
    [{ ...good, signature: good.signature.slice(0, -4) }, "signature"],
    [{ ...good, signature: "not base64!" }, "signature"],
  ];
  for (const [body, field] of cases) {
    assert.deepEqual(
      await checkInAt(deps, body, T + 5),
      { status: 400, body: { error: "invalid_request", field } },
      field,
    );
  }
});

test("POST /checkins runs the check-in end to end, and answers 503 until binding and minting are wired", async () => {
  const { db, deps, alice } = setup();
  const clock = { now: T + 5 };
  const base = {
    db,
    version: API_VERSION,
    stationSigner: ORGANIZER,
    stationDisplayToken: "test-display-token-0123456789abcdef",
    now: () => clock.now,
  };
  const wired = createApiServer({
    ...base,
    checkin: { registrations: deps.registrations, minter: deps.minter },
  });
  const unwired = createApiServer(base);
  const urls: string[] = [];
  for (const server of [wired, unwired]) {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    urls.push(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/checkins`,
    );
  }
  const post = (url: string, body: string, type = "application/json") =>
    fetch(url, { method: "POST", headers: { "content-type": type }, body });
  try {
    const req = JSON.stringify(request(alice, "LMN-0001"));
    const first = await post(urls[0]!, req);
    assert.equal(first.status, 201);
    assert.equal(
      ((await first.json()) as { status: string }).status,
      "checked_in",
    );
    const second = await post(urls[0]!, req);
    assert.deepEqual(
      [second.status, await second.json()],
      [409, { error: "already_checked_in" }],
    );
    const unavailable = await post(urls[1]!, req);
    assert.deepEqual(
      [unavailable.status, await unavailable.json()],
      [503, { error: "check_in_unavailable" }],
    );
    assert.equal((await post(urls[0]!, req, "text/plain")).status, 415);
    assert.equal((await post(urls[0]!, "{not json")).status, 400);
    assert.equal(
      (await post(urls[0]!, "x".repeat(MAX_CHECKIN_BODY_BYTES + 1))).status,
      413,
    );
    const get = await fetch(urls[0]!);
    assert.deepEqual([get.status, get.headers.get("allow")], [405, "POST"]);
  } finally {
    for (const server of [wired, unwired])
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("POST /checkins checks the QR window against the millisecond clock, not the whole second", async () => {
  const { db, deps, alice } = setup();
  // The whole-second clock reads T + 60, still inside the window; the real time is 500 ms later.
  const server = createApiServer({
    db,
    version: API_VERSION,
    stationSigner: ORGANIZER,
    stationDisplayToken: "test-display-token-0123456789abcdef",
    now: () => T + 60,
    nowMs: () => (T + 60) * 1000 + 500,
    checkin: { registrations: deps.registrations, minter: deps.minter },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/checkins`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request(alice, "LMN-0001", { issuedAt: T })),
    });
    assert.deepEqual(
      [res.status, await res.json()],
      [400, { error: "station_qr_expired" }],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
