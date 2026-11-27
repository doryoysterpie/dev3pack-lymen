import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { decodeBase64Url, encodeBase64, encodeBase64Url } from "./base64.ts";

test("encoding matches Node's Buffer, an independent implementation, for every length 0 to 70", () => {
  for (let n = 0; n <= 70; n++) {
    const bytes = randomBytes(n);
    assert.equal(
      encodeBase64(bytes),
      bytes.toString("base64"),
      `base64, ${n} bytes`,
    );
    assert.equal(
      encodeBase64Url(bytes),
      bytes.toString("base64url"),
      `base64url, ${n} bytes`,
    );
    assert.deepEqual(
      decodeBase64Url(bytes.toString("base64url")),
      new Uint8Array(bytes),
      `decode, ${n} bytes`,
    );
  }
});

test("decoding refuses other characters, impossible lengths and non-canonical spellings", () => {
  for (const text of ["ab+c", "ab/c", "abc=", "a b", "A", "AAAAA"]) {
    assert.equal(decodeBase64Url(text), null, text);
  }
  // "AB" and "AA" decode to the same byte in Buffer; only the canonical "AA" is accepted here.
  assert.deepEqual(
    Buffer.from("AB", "base64url"),
    Buffer.from("AA", "base64url"),
  );
  assert.deepEqual(decodeBase64Url("AA"), new Uint8Array([0]));
  assert.equal(decodeBase64Url("AB"), null);
  assert.deepEqual(decodeBase64Url(""), new Uint8Array(0));
});
