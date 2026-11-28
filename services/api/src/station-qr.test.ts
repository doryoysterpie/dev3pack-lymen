// E-03 done test: a QR older than 60 s is rejected; a payload with one byte changed is rejected;
// a payload signed by a non-allowlisted key is rejected. Plus the format the QR owes.
import assert from "node:assert/strict";
import { createPrivateKey, sign, verify, createPublicKey } from "node:crypto";
import { test } from "node:test";

import {
  issueStationQr,
  signerId,
  stationAllowlist,
  verifyStationQr,
  type StationSigner,
} from "./station-qr.ts";

// RFC 8032 section 7.1, TEST 1 and TEST 2: published Ed25519 test vectors, not real keys.
function rfcSigner(seedHex: string, publicHex: string): StationSigner {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(seedHex, "hex"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return { publicKey: Buffer.from(publicHex, "hex"), privateKey };
}
const ORGANIZER = rfcSigner(
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
);
const STRANGER = rfcSigner(
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
);
const ALLOWLIST = stationAllowlist([ORGANIZER.publicKey]);
const T = 1_795_000_000; // 2026-11-18T11:06:40Z, a fixed issue time
const NONCE = "AAECAwQFBgcICQoLDA0ODw"; // bytes 0x00..0x0f

function issue(signer: StationSigner = ORGANIZER, now = T): string {
  return issueStationQr({
    station: "st-front",
    session: "day-2",
    now,
    signer,
    nonce: NONCE,
  }).text;
}

/** Builds a QR by hand from the documented format, for payloads the issuer refuses to make. */
function craft(
  payloadJson: string,
  signer: StationSigner,
  claimedSigner = signer,
): string {
  const payload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const message = `limen:station:v1.${payload}`;
  const signature = sign(
    null,
    Buffer.from(message, "ascii"),
    signer.privateKey,
  );
  return `${message}.${signerId(claimedSigner.publicKey)}.${signature.toString("base64url")}`;
}

/** The verdict at Unix time `now`, in seconds; fractions are kept, as milliseconds. */
function reasonOf(text: string, now = T): string {
  const result = verifyStationQr(text, {
    allowlist: ALLOWLIST,
    nowMs: Math.round(now * 1000),
    expectedStation: "st-front",
  });
  return result.ok ? "ok" : result.reason;
}

test("an issued QR has the documented format and verifies to exactly the payload issued", () => {
  const text = issue();
  const parts = text.split(".");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "limen:station:v1");
  assert.equal(
    Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    `{"station":"st-front","session":"day-2","nonce":"${NONCE}","issued_at":${T},"expires_at":${T + 60}}`,
  );
  assert.equal(
    parts[2],
    Buffer.from(ORGANIZER.publicKey).toString("base64url"),
  );
  // The signature checks out independently of verifyStationQr, over the documented message.
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    ORGANIZER.publicKey,
  ]);
  assert.ok(
    verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      Buffer.from(parts[3] ?? "", "base64url"),
    ),
  );

  assert.deepEqual(
    verifyStationQr(text, {
      allowlist: ALLOWLIST,
      nowMs: T * 1000,
      expectedStation: "st-front",
    }),
    {
      ok: true,
      payload: {
        station: "st-front",
        session: "day-2",
        nonce: NONCE,
        issued_at: T,
        expires_at: T + 60,
      },
      signer: Buffer.from(ORGANIZER.publicKey).toString("base64url"),
    },
  );
});

test("done test 1: a QR older than 60 s is rejected as expired", () => {
  const text = issue();
  assert.equal(reasonOf(text, T + 30), "ok");
  assert.equal(reasonOf(text, T + 60), "ok");
  assert.equal(reasonOf(text, T + 61), "expired");
  assert.equal(reasonOf(text, T + 3600), "expired");
});

test("done test 1: the 60 s limit is measured in milliseconds, so 60.001 s and 60.999 s are rejected", () => {
  const text = issue();
  assert.equal(reasonOf(text, T + 60), "ok");
  assert.equal(reasonOf(text, T + 60.001), "expired");
  assert.equal(reasonOf(text, T + 60.999), "expired");
  assert.equal(reasonOf(text, T - 5), "ok");
  assert.equal(reasonOf(text, T - 5.001), "not_yet_valid");
});

test("with no usable clock the verifier fails closed: missing, NaN or infinite nowMs is invalid_clock", () => {
  const text = issue();
  const verdict = (options: unknown) => {
    const r = verifyStationQr(text, {
      expectedStation: "st-front",
      ...(options as object),
    } as {
      allowlist: ReadonlySet<string>;
      nowMs: number;
      expectedStation: string;
    });
    return r.ok ? "ok" : r.reason;
  };
  // The control: the same QR with a good clock is accepted.
  assert.equal(verdict({ allowlist: ALLOWLIST, nowMs: T * 1000 }), "ok");
  for (const nowMs of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "1795000000000",
  ]) {
    assert.equal(
      verdict({ allowlist: ALLOWLIST, nowMs }),
      "invalid_clock",
      String(nowMs),
    );
  }
  // The option E-05 used before the switch to milliseconds is refused, not read as "no limit".
  assert.equal(verdict({ allowlist: ALLOWLIST, now: T }), "invalid_clock");
});

test("a QR whose full 60 s would end exactly at its session's end is cut to 59 s, so it reads as cut short", () => {
  const { text, payload } = issueStationQr({
    station: "st-front",
    session: "day-2",
    now: T,
    signer: ORGANIZER,
    nonce: NONCE,
    notAfter: T + 60,
  });
  assert.equal(payload.expires_at, T + 59);
  assert.equal(reasonOf(text, T + 59 - 0.001), "ok");
  // Refused from its expires_at on, before the session's end, where the API moves on.
  assert.equal(reasonOf(text, T + 59), "expired");
  assert.equal(reasonOf(text, T + 60), "expired");
});

test("a QR issued near the end of its session expires when the session ends", () => {
  const sessionEnd = T + 1;
  const { text, payload } = issueStationQr({
    station: "st-front",
    session: "day-2",
    now: T,
    signer: ORGANIZER,
    nonce: NONCE,
    notAfter: sessionEnd,
  });
  assert.equal(payload.expires_at, sessionEnd);
  // A session's end is exclusive: from that instant the API issues for the next session, so a
  // QR cut short by the end is accepted 1 ms before the end and refused at the end itself.
  assert.equal(reasonOf(text, sessionEnd - 0.001), "ok");
  assert.equal(reasonOf(text, sessionEnd), "expired");
  assert.equal(reasonOf(text, sessionEnd + 0.001), "expired");
  assert.equal(reasonOf(text, T + 59), "expired");
  // Without a cap, or with one past 60 s, the QR keeps its full 60 s.
  assert.equal(
    issueStationQr({
      station: "st-front",
      session: "day-2",
      now: T,
      signer: ORGANIZER,
      notAfter: T + 3600,
    }).payload.expires_at,
    T + 60,
  );
  assert.throws(
    () =>
      issueStationQr({
        station: "st-front",
        session: "day-2",
        now: T,
        signer: ORGANIZER,
        notAfter: T,
      }),
    /notAfter must be a Unix time in whole seconds after now/,
  );
});

test("done test 1: a signed QR with a window over 60 s or an old issue time is still rejected", () => {
  const long = craft(
    `{"station":"st-front","session":"day-2","nonce":"${NONCE}","issued_at":${T},"expires_at":${T + 3600}}`,
    ORGANIZER,
  );
  assert.equal(reasonOf(long, T + 61), "invalid_payload");
  assert.equal(reasonOf(long, T), "invalid_payload");
  const stale = craft(
    `{"station":"st-front","session":"day-2","nonce":"${NONCE}","issued_at":${T - 61},"expires_at":${T - 1}}`,
    ORGANIZER,
  );
  assert.equal(reasonOf(stale, T), "expired");
});

test("a QR issued more than 5 s ahead of the verifier's clock is not yet valid", () => {
  assert.equal(reasonOf(issue(ORGANIZER, T + 5), T), "ok");
  assert.equal(reasonOf(issue(ORGANIZER, T + 6), T), "not_yet_valid");
});

test("done test 2: a payload with one byte changed is rejected, for every byte", () => {
  const text = issue();
  const [head, payload, signer, signature] = text.split(".") as [
    string,
    string,
    string,
    string,
  ];
  const bytes = Buffer.from(payload, "base64url");
  for (let i = 0; i < bytes.length; i++) {
    const changed = Buffer.from(bytes);
    changed[i] = (changed[i] ?? 0) ^ 0x01;
    const forged = [
      head,
      changed.toString("base64url"),
      signer,
      signature,
    ].join(".");
    assert.equal(
      reasonOf(forged),
      "bad_signature",
      `payload byte ${i} changed`,
    );
  }
  // The literal case: one character of the station ID changed.
  const json = bytes.toString("utf8").replace('"st-front"', '"st-frone"');
  const forged = [
    head,
    Buffer.from(json, "utf8").toString("base64url"),
    signer,
    signature,
  ].join(".");
  assert.equal(reasonOf(forged), "bad_signature");
});

test("done test 2: changing any one character anywhere in the QR text is rejected", () => {
  const text = issue();
  for (let i = 0; i < text.length; i++) {
    for (const c of ["A", "B", "_", "."]) {
      if (text[i] === c) continue;
      const forged = text.slice(0, i) + c + text.slice(i + 1);
      assert.notEqual(reasonOf(forged), "ok", `character ${i} changed to ${c}`);
    }
  }
});

test("done test 3: a payload signed by a non-allowlisted key is rejected", () => {
  assert.equal(reasonOf(issue(STRANGER)), "signer_not_allowlisted");
  // The same QR passes when its signer is on the allowlist, so the allowlist is what refused it.
  assert.equal(
    verifyStationQr(issue(STRANGER), {
      allowlist: stationAllowlist([STRANGER.publicKey]),
      nowMs: T * 1000,
      expectedStation: "st-front",
    }).ok,
    true,
  );
  assert.equal(
    verifyStationQr(issue(), {
      allowlist: stationAllowlist([]),
      nowMs: T * 1000,
      expectedStation: "st-front",
    }).ok,
    false,
  );
});

test("done test 3: a QR naming the allowlisted key but signed by another key is rejected", () => {
  const json = `{"station":"st-front","session":"day-2","nonce":"${NONCE}","issued_at":${T},"expires_at":${T + 60}}`;
  assert.equal(reasonOf(craft(json, STRANGER, ORGANIZER)), "bad_signature");
  assert.equal(reasonOf(craft(json, ORGANIZER)), "ok");
});

test("a signer or signature re-spelled in non-canonical base64url is rejected as malformed", () => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const text = issue();
  const [head, payload, signer, signature] = text.split(".") as [
    string,
    string,
    string,
    string,
  ];
  let respelled = 0;
  for (const [index, segment] of [
    [2, signer],
    [3, signature],
  ] as const) {
    const bytes = Buffer.from(segment, "base64url");
    for (const c of alphabet) {
      const variant = segment.slice(0, -1) + c;
      if (
        variant === segment ||
        !Buffer.from(variant, "base64url").equals(bytes)
      )
        continue;
      // Same bytes, different spelling: the non-canonical spelling is refused.
      const parts = [head, payload, signer, signature];
      parts[index] = variant;
      assert.equal(
        reasonOf(parts.join(".")),
        "malformed",
        `segment ${index} ending ${c}`,
      );
      respelled++;
    }
  }
  // 32 bytes leave 2 spare bits in the last signer character and 64 bytes leave 4 in the last
  // signature character, so 3 and 15 alternative spellings exist.
  assert.equal(respelled, 18);
});

test("text that is not a v1 station QR is rejected with the owed reason", () => {
  const text = issue();
  const [, payload, signer, signature] = text.split(".") as [
    string,
    string,
    string,
    string,
  ];
  assert.equal(reasonOf("https://example.com/"), "not_station_qr");
  assert.equal(reasonOf("solana:abc"), "not_station_qr");
  assert.equal(reasonOf(`limen:station:v1.${payload}.${signer}`), "malformed");
  assert.equal(reasonOf(`${text}.x`), "malformed");
  assert.equal(
    reasonOf(`limen:station:v2.${payload}.${signer}.${signature}`),
    "unsupported_version",
  );
  assert.equal(
    reasonOf(`limen:station:v1.${payload}=.${signer}.${signature}`),
    "malformed",
  );
  assert.equal(
    reasonOf(`limen:station:v1.${payload}.${signer}=.${signature}`),
    "malformed",
  );
  assert.equal(
    reasonOf(`limen:station:v1.${payload}.${signer.slice(0, -1)}.${signature}`),
    "malformed",
  );
  assert.equal(
    reasonOf(`limen:station:v1.${payload}.${signer}.${signature.slice(0, -1)}`),
    "malformed",
  );
  assert.equal(reasonOf(`${text}${"A".repeat(1024)}`), "malformed");
});

test("a signed payload without exactly the five valid fields is rejected as invalid", () => {
  const base = {
    station: "st-front",
    session: "day-2",
    nonce: NONCE,
    issued_at: T,
    expires_at: T + 60,
  };
  const cases: unknown[] = [
    { ...base, extra: 1 },
    { station: "st-front", session: "day-2", nonce: NONCE, issued_at: T },
    { ...base, station: "" },
    { ...base, station: "st front" },
    { ...base, session: "x".repeat(65) },
    { ...base, nonce: "short" },
    { ...base, nonce: "AAECAwQFBgcICQoLDA0ODx" }, // same 16 bytes as NONCE, non-canonical spelling
    { ...base, issued_at: T + 0.5 },
    { ...base, expires_at: String(T + 60) },
    { ...base, expires_at: T },
    [base],
    "text",
  ];
  for (const value of cases) {
    assert.equal(
      reasonOf(craft(JSON.stringify(value), ORGANIZER)),
      "invalid_payload",
      JSON.stringify(value),
    );
  }
  assert.equal(reasonOf(craft("{not json", ORGANIZER)), "invalid_payload");
});

test("each issued QR carries a fresh 16-byte nonce", () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { payload } = issueStationQr({
      station: "st-front",
      session: "day-2",
      now: T,
      signer: ORGANIZER,
    });
    assert.equal(Buffer.from(payload.nonce, "base64url").length, 16);
    nonces.add(payload.nonce);
  }
  assert.equal(nonces.size, 50);
});

test("the issuer refuses IDs and times outside the format", () => {
  assert.throws(
    () =>
      issueStationQr({
        station: "st front",
        session: "day-2",
        now: T,
        signer: ORGANIZER,
      }),
    /station ID/,
  );
  assert.throws(
    () =>
      issueStationQr({
        station: "st-front",
        session: "",
        now: T,
        signer: ORGANIZER,
      }),
    /session ID/,
  );
  assert.throws(
    () =>
      issueStationQr({
        station: "st-front",
        session: "day-2",
        now: 1.5,
        signer: ORGANIZER,
      }),
    /Unix time/,
  );
});

test("a QR for another station, or for another session when one is expected, is refused as wrong_station or wrong_session", () => {
  const text = issue(); // st-front, day-2
  const verdict = (expectedStation: string, expectedSession?: string) => {
    const r = verifyStationQr(text, {
      allowlist: ALLOWLIST,
      nowMs: T * 1000,
      expectedStation,
      ...(expectedSession === undefined ? {} : { expectedSession }),
    });
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(verdict("st-front"), "ok");
  assert.equal(verdict("st-side"), "wrong_station");
  assert.equal(verdict("st-front", "day-2"), "ok");
  assert.equal(verdict("st-front", "day-3"), "wrong_session");
  assert.equal(verdict("st-side", "day-3"), "wrong_station");
});

test("an expectedStation that is missing or not a station ID refuses every QR as wrong_station", () => {
  const text = issue();
  for (const expectedStation of [
    undefined,
    "",
    "st front",
    "x".repeat(65),
    7,
  ]) {
    const r = verifyStationQr(text, {
      allowlist: ALLOWLIST,
      nowMs: T * 1000,
      expectedStation,
    } as unknown as {
      allowlist: ReadonlySet<string>;
      nowMs: number;
      expectedStation: string;
    });
    assert.equal(
      r.ok ? "ok" : r.reason,
      "wrong_station",
      String(expectedStation),
    );
  }
});
