// E-05 done test, backend half: a second check-in in the same session is refused with the owed
// reason; an expired window is refused; a fresh wallet with no registration binding is refused.
// Registration binding is E-07's real code (registrationsFrom, on registrations imported with
// importRegistrations). Minting is E-06's mintPass on devnet, which spends devnet SOL, so a test
// whose check-in would succeed uses mintDouble, a named test double, instead.
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey, type Connection } from "@solana/web3.js";

import {
  checkIn,
  checkinMessage,
  devnetMinter,
  registrationsFrom,
  walletKeyAcceptable,
  walletSignatureValid,
  type CheckinDeps,
} from "./checkin.ts";
import { openDatabase } from "./db.ts";
import { start } from "./index.ts";
import { loadOrganizerKey } from "./organizer-key.ts";
import { connectDevnet } from "./pass-mint.ts";
import {
  bindRegistration,
  importRegistrations,
  registrationHash,
} from "./registration.ts";
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
/** A test value of REGISTRATION_SALT, at least 32 characters. */
const SALT = "test-registration-salt-0123456789abcdef";
/** RFC 8032 TEST 1 as a Solana keypair file: 32-byte seed, then the public key. */
const RFC_KEYPAIR = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];

interface Wallet {
  readonly address: string;
  readonly key: Uint8Array;
  readonly privateKey: KeyObject;
}

/** A fresh Ed25519 wallet; its address is the base58 of its public key, as Solana writes it. */
function wallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  );
  return { address: new PublicKey(key).toBase58(), key, privateKey };
}

/** The order L of Ed25519's prime-order subgroup (RFC 8032 section 5.1). */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const fromLittleEndian = (b: Uint8Array) =>
  BigInt(`0x${Buffer.from(b).reverse().toString("hex")}`);
const toLittleEndian32 = (n: bigint) =>
  Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
const hex = (s: string) => Buffer.from(s, "hex");

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
 * A wallet key with a torsion component: A = A0 + T8, where A0 is an ordinary public key. Honest
 * key generation never makes one. sign() returns a signature that the cofactorless equation
 * [S]B = R + [k]A accepts: R = [r]B + T' with T' of small order, tried until [k]T8 = -T', and
 * S = r + k a.
 */
function mixedOrderWallet() {
  const { scalar, point } = ed25519.utils.getExtendedPublicKey(
    Buffer.alloc(32, 7),
  );
  const key = Buffer.from(point.add(T8).toBytes());
  const torsion = Array.from({ length: 8 }, (_, i) =>
    T8.multiplyUnsafe(BigInt(i)),
  );
  return {
    address: new PublicKey(key).toBase58(),
    key,
    sign(message: Uint8Array): Buffer {
      for (;;) {
        const r = (fromLittleEndian(randomBytes(64)) % (L - 1n)) + 1n;
        for (const t of torsion) {
          const R = ed25519.Point.BASE.multiply(r).add(t).toBytes();
          const k =
            fromLittleEndian(
              createHash("sha512")
                .update(R)
                .update(key)
                .update(message)
                .digest(),
            ) % L;
          if (T8.multiplyUnsafe(k).add(t).is0())
            return Buffer.concat([R, toLittleEndian32((r + k * scalar) % L)]);
        }
      }
    },
  };
}

/** node:crypto's Ed25519 verify, as 7a1176c called it. */
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

/**
 * mintDouble: a test double for E-06's devnet mint (mintPass), used wherever a check-in would
 * succeed and so spend devnet SOL. It records each call and can be made to fail.
 */
function mintDouble() {
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
  `);
  // E-07's import, as `npm run import-registrations` runs it.
  importRegistrations(db, SALT, ["LMN-0001", "LMN-0002"]);
  const alice = wallet();
  const bob = wallet();
  const fresh = wallet();
  const minting = mintDouble();
  const deps: CheckinDeps = {
    db,
    allowlist: stationAllowlist([ORGANIZER.publicKey]),
    registrations: registrationsFrom(db, SALT),
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
      wallet: alice.address,
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
      reg_hash: registrationHash(SALT, "LMN-0001"),
      wallet: alice.address,
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

test("a wallet key outside the prime-order subgroup is refused, though node:crypto accepts its signature", async () => {
  const { db, deps, minting } = setup();
  const odd = mixedOrderWallet();
  const { text, payload } = issueStationQr({
    station: "st-front",
    session: "day-2",
    now: T,
    signer: ORGANIZER,
  });
  const message = Buffer.from(
    checkinMessage({
      ...payload,
      wallet: odd.address,
      registrationId: "LMN-0001",
    }),
    "utf8",
  );
  const signature = odd.sign(message);
  assert.equal(nodeVerifies(odd.key, message, signature), true);
  assert.deepEqual(
    await checkInAt(
      deps,
      {
        qr: text,
        wallet: odd.address,
        registration_id: "LMN-0001",
        signature: signature.toString("base64"),
      },
      T + 5,
    ),
    { status: 400, body: { error: "invalid_request", field: "wallet" } },
  );
  assert.equal(minting.calls.length, 0);
  assert.equal(checkinCount(db), 0);
});

test("the strict Ed25519 check refuses the 12 speccheck vectors and the eight small-order points, and accepts real signatures", async () => {
  for (const [i, [message, key, signature]] of SPECCHECK.entries()) {
    assert.equal(
      await walletSignatureValid(hex(key), hex(message), hex(signature)),
      false,
      `speccheck vector ${i}`,
    );
  }
  const small = smallOrderPoints();
  assert.equal(small.length, 8);
  assert.equal(
    new Set(small.map((p) => p.toString("hex"))).size,
    8,
    "eight distinct encodings",
  );
  // RFC 8032 TEST 1's key, with its scalar, signs with each small-order point as R.
  const seed = hex(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  );
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
  const message = Buffer.from("limen check-in v1", "utf8");
  for (const point of small) {
    assert.equal(ed25519.Point.fromBytes(point, false).isSmallOrder(), true);
    assert.equal(await walletKeyAcceptable(point), false, "as a public key");
    // S = k a satisfies the cofactored equation, which noble's own verify checks.
    const k =
      fromLittleEndian(
        createHash("sha512")
          .update(point)
          .update(pointBytes)
          .update(message)
          .digest(),
      ) % L;
    const signature = Buffer.concat([
      point,
      toLittleEndian32((k * scalar) % L),
    ]);
    assert.equal(
      ed25519.verify(signature, message, pointBytes, { zip215: false }),
      true,
      "noble alone accepts it",
    );
    assert.equal(
      await walletSignatureValid(pointBytes, message, signature),
      false,
      "as R",
    );
  }
  // Real signatures: RFC 8032 TEST 1 and TEST 2, and 20 fresh keys.
  const signers = [ORGANIZER, STRANGER];
  for (const signer of signers) {
    const signature = sign(null, message, signer.privateKey);
    assert.equal(
      await walletSignatureValid(signer.publicKey, message, signature),
      true,
    );
  }
  for (let i = 0; i < 20; i++) {
    const w = wallet();
    const text = Buffer.from(`message ${i}`, "utf8");
    assert.equal(await walletKeyAcceptable(w.key), true);
    assert.equal(
      await walletSignatureValid(w.key, text, sign(null, text, w.privateKey)),
      true,
    );
  }
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

test("a registration ID sent in a key or in a value does not appear in the response", async () => {
  const { deps, alice } = setup();
  const good = request(alice, "LMN-0001");
  // A key that is not one of the request's four fields gets one fixed answer, with no name.
  assert.deepEqual(await checkInAt(deps, { ...good, "LMN-0002": 1 }, T + 5), {
    status: 400,
    body: { error: "invalid_request", reason: "unexpected_field" },
  });
  const unknown = request(alice, "LMN-9999");
  const bodies: [string, unknown][] = [
    ["LMN-0002", { ...good, "LMN-0002": 1 }],
    ["LMN-0002", { "LMN-0002": good.qr }],
    ["LMN-0002", { ...good, qr: "LMN-0002" }],
    ["LMN-0002", { ...good, wallet: "LMN-0002" }],
    ["LMN-0002", { ...good, registration_id: "LMN-0002\n" }],
    ["LMN-0002", { ...good, signature: "LMN-0002" }],
    // A well-formed, correctly signed ID that is not imported.
    ["LMN-9999", unknown],
  ];
  for (const [id, body] of bodies) {
    const answer = await checkInAt(deps, body, T + 5);
    assert.equal(answer.status >= 400, true);
    assert.ok(
      !JSON.stringify(answer.body).includes(id),
      `${JSON.stringify(answer.body)} carries ${id}`,
    );
  }
});

test("POST /checkins runs the check-in end to end, and answers 503 on a server built without check-in", async () => {
  const { db, deps, alice } = setup();
  const clock = { now: T + 5 };
  const base = {
    db,
    version: API_VERSION,
    stationSigner: ORGANIZER,
    stationDisplayToken: "test-display-token-0123456789abcdef",
    nowMs: () => clock.now * 1000,
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

test("the API reads one millisecond clock: a server built without nowMs is refused", () => {
  const { db, deps } = setup();
  // A JavaScript caller could pass only a whole-second clock; at 60.500 s that read 60.000 s.
  const secondsOnly = {
    db,
    version: API_VERSION,
    stationSigner: ORGANIZER,
    stationDisplayToken: "test-display-token-0123456789abcdef",
    now: () => T + 60,
    checkin: { registrations: deps.registrations, minter: deps.minter },
  } as unknown as Parameters<typeof createApiServer>[0];
  assert.throws(() => createApiServer(secondsOnly), {
    message: "createApiServer needs nowMs, the API's millisecond clock",
  });
});

test("POST /checkins checks the QR window against the millisecond clock: at 60.500 s a QR is refused", async () => {
  const { db, deps, alice } = setup();
  const server = createApiServer({
    db,
    version: API_VERSION,
    stationSigner: ORGANIZER,
    stationDisplayToken: "test-display-token-0123456789abcdef",
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

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("the running API checks in with E-07's binding: refusals only the salted binding can give, and 503 without REGISTRATION_SALT", async () => {
  // No request here can succeed, so nothing is minted and no devnet SOL is spent.
  const dir = mkdtempSync(join(tmpdir(), "limen-checkin-"));
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  const dbPath = join(dir, "limen.db");
  const now = Math.floor(Date.now() / 1000);
  const db = openDatabase(dbPath);
  db.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', ${now});
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-2', 'Day 2', ${now - 3600}, ${now + 3600});
  `);
  importRegistrations(db, SALT, ["LMN-0001"]);
  const alice = wallet();
  const bob = wallet();
  // LMN-0001 is bound to bob through E-07's own code, under the same salt.
  assert.equal(
    bindRegistration(db, SALT, "LMN-0001", bob.address, now).ok,
    true,
  );
  const env = (extra: Record<string, string>) => ({
    ORGANIZER_KEYPAIR_PATH: keyPath,
    STATION_DISPLAY_TOKEN: "test-display-token-0123456789abcdef",
    DATABASE_PATH: dbPath,
    ...extra,
  });
  const started: { server: { close(cb: () => void): void } }[] = [];
  try {
    const wired = await start(
      env({ REGISTRATION_SALT: SALT, API_PORT: String(await freePort()) }),
    );
    started.push(wired);
    const unwired = await start(env({ API_PORT: String(await freePort()) }));
    started.push(unwired);
    const post = (url: string, body: unknown) =>
      fetch(`${url}/checkins`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const answer = async (res: Response) => [res.status, await res.json()];
    assert.deepEqual(
      await answer(
        await post(wired.url, request(alice, "LMN-0001", { issuedAt: now })),
      ),
      [403, { error: "registration_bound_to_other_wallet" }],
    );
    assert.deepEqual(
      await answer(
        await post(wired.url, request(alice, null, { issuedAt: now })),
      ),
      [403, { error: "no_registration_binding" }],
    );
    assert.deepEqual(
      await answer(
        await post(unwired.url, request(alice, null, { issuedAt: now })),
      ),
      [503, { error: "check_in_unavailable" }],
    );
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM checkins").get() as { n: number })
        .n,
      0,
    );
    // A short salt stops start-up, and the message does not echo it.
    await assert.rejects(
      start(
        env({
          REGISTRATION_SALT: "short-salt",
          API_PORT: String(await freePort()),
        }),
      ),
      (err: Error) =>
        /^REGISTRATION_SALT must be set to at least 32 characters \(it is too short\)/.test(
          err.message,
        ) && !err.message.includes("short-salt"),
    );
  } finally {
    for (const s of started)
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the API refuses a SOLANA_RPC_URL that is not the allowlisted devnet endpoint at start-up, without echoing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-checkin-"));
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  const env = (extra: Record<string, string>) => ({
    ORGANIZER_KEYPAIR_PATH: keyPath,
    STATION_DISPLAY_TOKEN: "test-display-token-0123456789abcdef",
    DATABASE_PATH: join(dir, "limen.db"),
    ...extra,
  });
  const started: { server: { close(cb: () => void): void } }[] = [];
  try {
    for (const url of [
      "http://api.devnet.solana.com",
      "https://api.devnet.solana.com/",
      "https://api.devnet.solana.com.example.test",
      "http://127.0.0.1:8899",
      "https://rpc.example.test/?api-key=secret-value-0123",
    ]) {
      for (const salt of [{ REGISTRATION_SALT: SALT }, {}] as Record<
        string,
        string
      >[]) {
        // A server that starts is kept so it can be closed, and then the test fails.
        const outcome = await start(
          env({
            ...salt,
            SOLANA_RPC_URL: url,
            API_PORT: String(await freePort()),
          }),
        ).then(
          (s) => {
            started.push(s);
            return null;
          },
          (err: Error) => err,
        );
        assert.ok(outcome instanceof Error, `started with ${url}`);
        assert.equal(
          outcome.message,
          "SOLANA_RPC_URL must be https://api.devnet.solana.com, the one devnet endpoint limen calls (D-03); unset, it is used.",
        );
        assert.ok(!outcome.message.includes("secret-value"));
      }
    }
    // The allowlisted endpoint, and no setting at all, both start.
    for (const extra of [
      { SOLANA_RPC_URL: "https://api.devnet.solana.com" },
      {},
    ] as Record<string, string>[]) {
      started.push(
        await start(
          env({
            REGISTRATION_SALT: SALT,
            ...extra,
            API_PORT: String(await freePort()),
          }),
        ),
      );
    }
  } finally {
    for (const s of started)
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the minter reaches only the allowlisted devnet endpoint: another URL is refused when it is built, and another cluster after one getGenesisHash", async () => {
  const { db, deps, alice } = setup();
  const dir = mkdtempSync(join(tmpdir(), "limen-checkin-"));
  const keyPath = join(dir, "organizer.json");
  writeFileSync(keyPath, JSON.stringify(RFC_KEYPAIR));
  // A connection that answers with another cluster's genesis hash and records every call made.
  const calls: string[] = [];
  const otherCluster = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "then"
          ? undefined
          : async () => {
              calls.push(String(name));
              return name === "getGenesisHash"
                ? "not-the-devnet-genesis-hash"
                : undefined;
            },
    },
  ) as unknown as Connection;
  try {
    // A URL off the allowlist is refused before any connection is made.
    assert.throws(
      () =>
        devnetMinter("http://127.0.0.1:9/", loadOrganizerKey(keyPath), (url) =>
          connectDevnet(url, () => otherCluster),
        ),
      {
        message:
          "SOLANA_RPC_URL must be https://api.devnet.solana.com, the one devnet endpoint limen calls (D-03); unset, it is used.",
      },
    );
    assert.deepEqual(calls, []);
    // The genesis check stays as a second guard: an endpoint that answers another cluster's
    // genesis hash is refused after that one call, and nothing is sent.
    const minter = devnetMinter(
      "https://api.devnet.solana.com",
      loadOrganizerKey(keyPath),
      (url) => connectDevnet(url, () => otherCluster),
    );
    assert.deepEqual(
      await checkInAt({ ...deps, minter }, request(alice, "LMN-0001"), T + 5),
      { status: 502, body: { error: "mint_failed" } },
    );
    assert.deepEqual(calls, ["getGenesisHash"]);
    assert.equal(checkinCount(db), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
