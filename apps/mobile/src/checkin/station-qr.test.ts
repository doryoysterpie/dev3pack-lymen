// E-05 app half: the device verifies E-03's fixture station QRs to the answers E-03's own
// verifier gives. Ed25519 here is node:crypto; on the device it is the library passed in.
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { verifyStationQrOnDevice, type Ed25519Verify } from "./station-qr.ts";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/station-qr/e05-app.json", import.meta.url),
    "utf8",
  ),
) as {
  issued_at: number;
  nonce: string;
  organizer_signer_id: string;
  stranger_signer_id: string;
  valid: string;
  stranger: string;
  tampered: string;
};
const T = FIXTURE.issued_at;
const ALLOWLIST = new Set([FIXTURE.organizer_signer_id]);

const nodeVerify: Ed25519Verify = (publicKey, message, signature) =>
  verify(
    null,
    message,
    createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        publicKey,
      ]),
      format: "der",
      type: "spki",
    }),
    signature,
  );

const reasonAt = (
  text: string,
  now: number,
  allowlist: ReadonlySet<string> = ALLOWLIST,
) => {
  const r = verifyStationQrOnDevice(text, {
    allowlist,
    now,
    verify: nodeVerify,
  });
  return r.ok ? "ok" : r.reason;
};

test("the valid fixture QR verifies to exactly the payload E-03 issued", () => {
  assert.deepEqual(
    verifyStationQrOnDevice(FIXTURE.valid, {
      allowlist: ALLOWLIST,
      now: T + 30,
      verify: nodeVerify,
    }),
    {
      ok: true,
      payload: {
        station: "st-front",
        session: "day-2",
        nonce: FIXTURE.nonce,
        issued_at: T,
        expires_at: T + 60,
      },
      signer: FIXTURE.organizer_signer_id,
    },
  );
});

test("an expired QR is refused: ok at 60 s, expired at 61 s", () => {
  assert.equal(reasonAt(FIXTURE.valid, T), "ok");
  assert.equal(reasonAt(FIXTURE.valid, T + 60), "ok");
  assert.equal(reasonAt(FIXTURE.valid, T + 61), "expired");
  assert.equal(reasonAt(FIXTURE.valid, T - 6), "not_yet_valid");
});

test("a QR with one payload byte changed is refused as bad_signature", () => {
  assert.equal(reasonAt(FIXTURE.tampered, T), "bad_signature");
  // And no single-character change anywhere in the valid QR is accepted.
  for (let i = 0; i < FIXTURE.valid.length; i++) {
    for (const c of ["A", "_", "."]) {
      if (FIXTURE.valid[i] === c) continue;
      const changed =
        FIXTURE.valid.slice(0, i) + c + FIXTURE.valid.slice(i + 1);
      assert.notEqual(
        reasonAt(changed, T),
        "ok",
        `character ${i} changed to ${c}`,
      );
    }
  }
});

test("a QR signed by a key off the allowlist is refused as signer_not_allowlisted", () => {
  assert.equal(reasonAt(FIXTURE.stranger, T), "signer_not_allowlisted");
  // The same QR passes once its key is allowlisted, so the allowlist is what refused it.
  assert.equal(
    reasonAt(FIXTURE.stranger, T, new Set([FIXTURE.stranger_signer_id])),
    "ok",
  );
  assert.equal(reasonAt(FIXTURE.valid, T, new Set()), "signer_not_allowlisted");
});

test("other text, a throwing verifier and wrong shapes are refused with the owed reason", () => {
  assert.equal(reasonAt("https://example.com/", T), "not_station_qr");
  assert.equal(reasonAt(`${FIXTURE.valid}.x`, T), "malformed");
  assert.equal(
    reasonAt(
      FIXTURE.valid.replace("limen:station:v1.", "limen:station:v2."),
      T,
    ),
    "unsupported_version",
  );
  const throwing = verifyStationQrOnDevice(FIXTURE.valid, {
    allowlist: ALLOWLIST,
    now: T,
    verify: () => {
      throw new Error("library failure");
    },
  });
  assert.deepEqual(throwing, { ok: false, reason: "bad_signature" });
});
