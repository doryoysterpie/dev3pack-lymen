// Base58 decoding against known Solana program IDs. The expected bytes were computed with an
// independent big-integer decoder, not with this module.
import assert from "node:assert/strict";
import { test } from "node:test";

import { randomBytes } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import { decodeBase58, encodeBase58, isPublicKey } from "./base58.ts";

const hex = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

test("the System Program ID decodes to 32 zero bytes", () => {
  assert.equal(
    hex(decodeBase58("11111111111111111111111111111111")),
    "00".repeat(32),
  );
});

test("the SPL Token and Token-2022 program IDs decode to their owed bytes", () => {
  assert.equal(
    hex(decodeBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
    "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
  );
  assert.equal(
    hex(decodeBase58("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")),
    "06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc",
  );
});

test("text outside the alphabet does not decode", () => {
  assert.equal(decodeBase58("0OIl"), null);
  assert.equal(
    isPublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5D0"),
    false,
  );
});

test("encoding gives the owed program IDs and agrees with @solana/web3.js on 100 random keys", () => {
  assert.equal(
    encodeBase58(Buffer.alloc(32)),
    "11111111111111111111111111111111",
  );
  assert.equal(
    encodeBase58(
      Buffer.from(
        "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
        "hex",
      ),
    ),
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );
  for (let i = 0; i < 100; i++) {
    const key = randomBytes(32);
    // Some keys start with zero bytes, which base58 writes as leading "1"s.
    key.fill(0, 0, i % 3);
    const text = encodeBase58(key);
    assert.equal(text, new PublicKey(key).toBase58());
    assert.equal(hex(decodeBase58(text)), key.toString("hex"));
  }
});

test("only 32-byte keys count as public keys", () => {
  assert.equal(
    isPublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    true,
  );
  assert.equal(isPublicKey("11111111111111111111111111111111"), true);
  // 31 and 33 ones decode to 31 and 33 zero bytes.
  assert.equal(isPublicKey("1".repeat(31)), false);
  assert.equal(isPublicKey("1".repeat(33)), false);
  assert.equal(isPublicKey(""), false);
});
