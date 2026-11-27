// The device's Ed25519 (@noble/curves) agrees with node:crypto (OpenSSL), the verifier the
// backend runs, on RFC 8032's published vectors, E-03's fixture QRs and random keys.
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ed25519Verify } from "./ed25519.ts";
import { verifyStationQrOnDevice } from "./station-qr.ts";

test("RFC 8032 section 7.1 TEST 1 and TEST 2 verify, and fail with one bit changed", () => {
  const vectors = [
    {
      pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      msg: "",
      sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    },
    {
      pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
      msg: "72",
      sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    },
  ];
  for (const v of vectors) {
    const pub = Buffer.from(v.pub, "hex");
    const msg = Buffer.from(v.msg, "hex");
    const sig = Buffer.from(v.sig, "hex");
    assert.equal(ed25519Verify(pub, msg, sig), true);
    const bad = Buffer.from(sig);
    bad[0] = (bad[0] ?? 0) ^ 1;
    assert.equal(ed25519Verify(pub, msg, bad), false);
  }
});

test("E-03's fixture QRs give the same answers with noble as with node:crypto", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../../fixtures/station-qr/e05-app.json", import.meta.url),
      "utf8",
    ),
  ) as {
    issued_at: number;
    organizer_signer_id: string;
    valid: string;
    stranger: string;
    tampered: string;
  };
  const allowlist = new Set([fixture.organizer_signer_id]);
  const nowMs = (fixture.issued_at + 30) * 1000;
  const reason = (text: string) => {
    const r = verifyStationQrOnDevice(text, {
      allowlist,
      nowMs,
      verify: ed25519Verify,
    });
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(reason(fixture.valid), "ok");
  assert.equal(reason(fixture.tampered), "bad_signature");
  assert.equal(reason(fixture.stranger), "signer_not_allowlisted");
});

test("noble and node:crypto agree on 200 random signatures, valid and altered", () => {
  for (let i = 0; i < 200; i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = Buffer.from(
      publicKey.export({ format: "jwk" }).x ?? "",
      "base64url",
    );
    const msg = randomBytes(i % 70);
    const sig = sign(null, msg, privateKey);
    if (i % 2 === 1) sig[i % 64] = (sig[i % 64] ?? 0) ^ 0x40;
    const node = verify(
      null,
      msg,
      createPublicKey({
        key: publicKey.export({ format: "der", type: "spki" }),
        format: "der",
        type: "spki",
      }),
      sig,
    );
    assert.equal(ed25519Verify(pub, msg, sig), node, `case ${i}`);
  }
});

test("a key or signature of the wrong length is refused, not thrown", () => {
  assert.equal(
    ed25519Verify(new Uint8Array(31), new Uint8Array(0), new Uint8Array(64)),
    false,
  );
  assert.equal(
    ed25519Verify(new Uint8Array(32), new Uint8Array(0), new Uint8Array(63)),
    false,
  );
});
