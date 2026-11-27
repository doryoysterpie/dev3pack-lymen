import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeBase58, decodePublicKey, encodeBase58 } from "./base58.ts";

const hex = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

// Owed values were computed with an independent integer-arithmetic decoder.
const OWED: ReadonlyArray<readonly [string, string | null]> = [
  [
    "11111111111111111111111111111111",
    "0000000000000000000000000000000000000000000000000000000000000000",
  ],
  [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
  ],
  [
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc",
  ],
  ["1", "00"],
  ["11", "0000"],
  ["1z", "0039"],
  ["z", "39"],
  ["2g", "61"],
  ["abc", "01b97b"],
  ["1112", "00000001"],
  ["", ""],
  // 0, O, I and l are not in the base58 alphabet.
  ["0OIl", null],
  ["abc!", null],
];

describe("decodeBase58", () => {
  for (const [text, expected] of OWED) {
    it(JSON.stringify(text), () => {
      assert.equal(hex(decodeBase58(text)), expected);
    });
  }
});

describe("encodeBase58", () => {
  for (const [text, bytes] of OWED) {
    if (bytes === null) continue;
    it(`encodes ${JSON.stringify(bytes)}`, () => {
      assert.equal(encodeBase58(Buffer.from(bytes, "hex")), text);
    });
  }
});

describe("decodePublicKey", () => {
  it("accepts base58 that decodes to 32 bytes", () => {
    assert.equal(
      hex(decodePublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
      "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
    );
  });

  it("refuses 31 and 33 bytes, the empty string and over-long text", () => {
    assert.equal(decodePublicKey("1".repeat(31)), null);
    assert.equal(decodePublicKey("1".repeat(33)), null);
    assert.equal(decodePublicKey(""), null);
    assert.equal(decodePublicKey("2".repeat(45)), null);
  });
});
