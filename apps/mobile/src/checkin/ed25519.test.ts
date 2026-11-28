// The device's Ed25519 refuses what the backend's strict check refuses (walletSignatureValid in
// services/api/src/checkin.ts, E-05): the speccheck vectors, the small-order points as key or
// as R, and a mixed-order key. On honest keys it agrees with node:crypto (OpenSSL), the verifier
// E-03's station QR check runs: RFC 8032's published vectors, E-03's fixture QRs and random keys.
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ed25519 } from "@noble/curves/ed25519.js";

import { ed25519Verify } from "./ed25519.ts";
import { verifyStationQrOnDevice } from "./station-qr.ts";

/** The order L of Ed25519's prime-order subgroup (RFC 8032 section 5.1). */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const fromLittleEndian = (b: Uint8Array) =>
  BigInt(`0x${Buffer.from(b).reverse().toString("hex")}`);
const toLittleEndian32 = (n: bigint) =>
  Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
const hex = (s: string) => Buffer.from(s, "hex");
const sha512Scalar = (...parts: Uint8Array[]) => {
  const h = createHash("sha512");
  for (const part of parts) h.update(part);
  return fromLittleEndian(h.digest()) % L;
};

// The vectors and points below are the backend test's own (services/api/src/checkin.test.ts).
/**
 * The 12 Ed25519 edge-case vectors (message, public key, signature) of "Taming the many EdDSAs"
 * (Chalkias, Garillot and Nikolaenko, 2020), from cases.json in
 * github.com/novifinancial/ed25519-speccheck at commit 65519336fda7, Apache-2.0 licensed. Each
 * has a small or mixed-order A or R, an S at or over L, or a non-canonical A or R, per the
 * condition table in that repository's README.
 */
const SPECCHECK: readonly (readonly [string, string, string])[] = [
  [
    "8c93255d71dcab10e8f379c26200f3c7bd5f09d9bc3068d3ef4edeb4853022b6",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a0000000000000000000000000000000000000000000000000000000000000000",
  ],
  [
    "9bd9f44f4dcc75bd531b56b2cd280b0bb38fc1cd6d1230e14861d861de092e79",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43a5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04",
  ],
  [
    "aebf3f2601a0c8c5d39cc7d8911642f740b78168218da8471772b35f9d35b9ab",
    "f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa8c4bd45aecaca5b24fb97bc10ac27ac8751a7dfe1baff8b953ec9f5833ca260e",
  ],
  [
    "9bd9f44f4dcc75bd531b56b2cd280b0bb38fc1cd6d1230e14861d861de092e79",
    "cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d",
    "9046a64750444938de19f227bb80485e92b83fdb4b6506c160484c016cc1852f87909e14428a7a1d62e9f22f3d3ad7802db02eb2e688b6c52fcd6648a98bd009",
  ],
  [
    "e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec4011eaccd55b53f56c",
    "cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d",
    "160a1cb0dc9c0258cd0a7d23e94d8fa878bcb1925f2c64246b2dee1796bed5125ec6bc982a269b723e0668e540911a9a6a58921d6925e434ab10aa7940551a09",
  ],
  [
    "e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec4011eaccd55b53f56c",
    "cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d",
    "21122a84e0b5fca4052f5b1235c80a537878b38f3142356b2c2384ebad4668b7e40bc836dac0f71076f9abe3a53f9c03c1ceeeddb658d0030494ace586687405",
  ],
  [
    "85e241a07d148b41e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec40",
    "442aad9f089ad9e14647b1ef9099a1ff4798d78589e66f28eca69c11f582a623",
    "e96f66be976d82e60150baecff9906684aebb1ef181f67a7189ac78ea23b6c0e547f7690a0e2ddcd04d87dbc3490dc19b3b3052f7ff0538cb68afb369ba3a514",
  ],
  [
    "85e241a07d148b41e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec40",
    "442aad9f089ad9e14647b1ef9099a1ff4798d78589e66f28eca69c11f582a623",
    "8ce5b96c8f26d0ab6c47958c9e68b937104cd36e13c33566acd2fe8d38aa19427e71f98a473474f2f13f06f97c20d58cc3f54b8bd0d272f42b695dd7e89a8c22",
  ],
  [
    "9bedc267423725d473888631ebf45988bad3db83851ee85c85e241a07d148b41",
    "f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff03be9678ac102edcd92b0210bb34d7428d12ffc5df5f37e359941266a4e35f0f",
  ],
  [
    "9bedc267423725d473888631ebf45988bad3db83851ee85c85e241a07d148b41",
    "f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffca8c5b64cd208982aa38d4936621a4775aa233aa0505711d8fdcfdaa943d4908",
  ],
  [
    "e96b7021eb39c1a163b6da4e3093dcd3f21387da4cc4572be588fafae23c155b",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "a9d55260f765261eb9b84e106f665e00b867287a761990d7135963ee0a7d59dca5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04",
  ],
  [
    "39a591f5321bbe07fd5a23dc2f39d025d74526615746727ceefd6e82ae65c06f",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "a9d55260f765261eb9b84e106f665e00b867287a761990d7135963ee0a7d59dca5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04",
  ],
];

/**
 * The eight small-order points of Ed25519, canonically encoded. The y-coordinates are the five
 * canonical entries of the small-order list in libsodium 1.0.16's ge25519_has_small_order
 * (src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c), which compares with the sign bit
 * cleared: 1 (order 1), p - 1 (order 2), 0 (order 4) and two of order 8. Each y with x != 0 has two
 * points, one per sign bit.
 */
function smallOrderPoints(): Buffer[] {
  const ys = [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  ];
  const points: Buffer[] = [];
  for (const y of ys) {
    for (const sign of [0, 0x80]) {
      const bytes = hex(y);
      bytes[31]! |= sign;
      try {
        ed25519.Point.fromBytes(bytes, false);
        points.push(bytes);
      } catch {
        // x = 0 with the sign bit set is not a canonical encoding.
      }
    }
  }
  return points;
}

/** A point of order 8, the first order-8 entry above. */
const T8 = ed25519.Point.fromBytes(
  hex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
  false,
);

/**
 * A key with a torsion component, A = A0 + T8, and a signature over `message` that the
 * cofactorless equation [S]B = R + [k]A accepts: R = [r]B + T' with T' of small order, tried
 * until [k]T8 = -T', and S = r + k a. Honest key generation never makes such a key.
 */
function mixedOrderSignature(message: Uint8Array) {
  const { scalar, point } = ed25519.utils.getExtendedPublicKey(
    Buffer.alloc(32, 7),
  );
  const key = Buffer.from(point.add(T8).toBytes());
  const torsion = Array.from({ length: 8 }, (_, i) =>
    T8.multiplyUnsafe(BigInt(i)),
  );
  for (;;) {
    const r = (fromLittleEndian(randomBytes(64)) % (L - 1n)) + 1n;
    for (const t of torsion) {
      const R = ed25519.Point.BASE.multiply(r).add(t).toBytes();
      const k = sha512Scalar(R, key, message);
      if (T8.multiplyUnsafe(k).add(t).is0())
        return {
          key,
          signature: Buffer.concat([R, toLittleEndian32((r + k * scalar) % L)]),
        };
    }
  }
}

/** node:crypto's Ed25519 verify on a raw 32-byte key. */
function nodeVerifies(
  key: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  return verify(
    null,
    message,
    createPublicKey({
      key: Buffer.concat([hex("302a300506032b6570032100"), key]),
      format: "der",
      type: "spki",
    }),
    signature,
  );
}

test("the device refuses what the backend's strict check refuses, though noble or OpenSSL alone accepts some of it", () => {
  for (const [i, [message, key, signature]] of SPECCHECK.entries())
    assert.equal(
      ed25519Verify(hex(key), hex(message), hex(signature)),
      false,
      `speccheck vector ${i}`,
    );
  const small = smallOrderPoints();
  assert.equal(new Set(small.map((p) => p.toString("hex"))).size, 8);
  // RFC 8032 TEST 1's key, with its scalar, signs with each small-order point as R.
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(
    hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
  );
  const message = Buffer.from("limen check-in v1", "utf8");
  for (const point of small) {
    assert.equal(
      ed25519Verify(point, message, Buffer.concat([point, Buffer.alloc(32)])),
      false,
      "as the key",
    );
    const k = sha512Scalar(point, pointBytes, message);
    const signature = Buffer.concat([
      point,
      toLittleEndian32((k * scalar) % L),
    ]);
    assert.equal(
      ed25519.verify(signature, message, pointBytes, { zip215: false }),
      true,
      "noble alone accepts it",
    );
    assert.equal(ed25519Verify(pointBytes, message, signature), false, "as R");
  }
  const odd = mixedOrderSignature(message);
  assert.equal(nodeVerifies(odd.key, message, odd.signature), true);
  assert.equal(ed25519Verify(odd.key, message, odd.signature), false);
});

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
