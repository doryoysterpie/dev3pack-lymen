import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { decodeBase58 } from "../qr/base58.ts";
import {
  decodeBase64,
  encodeBase58,
  walletAddressFromMwa,
} from "./wallet-address.ts";

// Expected addresses from @solana/web3.js PublicKey.toBase58() for these bytes.
const VECTORS: [string, string][] = [
  ["00".repeat(32), "11111111111111111111111111111111"],
  [
    "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ],
  [
    "55c24c24872557ffd8028d2ab1ccd9b38095d52e048d2987915cb8ba970fd96b",
    "6mmVXu9m4A3FQsggw4qxZzyjkA6GX5XKDK1cMUcmTF14",
  ],
];

test("base58 encoding gives the addresses @solana/web3.js gives", () => {
  for (const [hex, address] of VECTORS) {
    assert.equal(encodeBase58(Buffer.from(hex, "hex")), address);
  }
});

test("random 32-byte keys round-trip through the scanner's independent base58 decoder", () => {
  for (let i = 0; i < 200; i++) {
    const key = randomBytes(32);
    if (i % 50 === 0) key[0] = 0; // keep some leading zero bytes in the mix
    assert.deepEqual(decodeBase58(encodeBase58(key)), new Uint8Array(key));
  }
});

test("an MWA account's base64 key becomes its base58 address, and nothing else does", () => {
  const token = Buffer.from(VECTORS[1]![0], "hex");
  assert.equal(
    walletAddressFromMwa(token.toString("base64")),
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );
  assert.equal(walletAddressFromMwa(randomBytes(31).toString("base64")), null);
  assert.equal(walletAddressFromMwa(randomBytes(33).toString("base64")), null);
  assert.equal(walletAddressFromMwa("not base64!"), null);
  assert.equal(
    walletAddressFromMwa(token.toString("base64url")),
    null,
    "base64url is not what MWA sends",
  );
  assert.deepEqual(decodeBase64("AA=="), new Uint8Array([0]));
  assert.equal(decodeBase64("AB=="), null, "non-canonical");
});
