import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { decodeBase64, encodeBase64 } from "./base64.ts";

describe("base64", () => {
  it("matches Node's Buffer on 1000 random inputs of 0 to 299 bytes", () => {
    for (let i = 0; i < 1000; i += 1) {
      const bytes = randomBytes(i % 300);
      const owed = bytes.toString("base64");
      assert.equal(encodeBase64(bytes), owed);
      assert.deepEqual(decodeBase64(owed), new Uint8Array(bytes));
    }
  });

  it("decodes the padding cases", () => {
    assert.deepEqual(decodeBase64(""), new Uint8Array([]));
    assert.deepEqual(decodeBase64("QQ=="), new Uint8Array([0x41]));
    assert.deepEqual(decodeBase64("QUI="), new Uint8Array([0x41, 0x42]));
    assert.deepEqual(decodeBase64("QUJD"), new Uint8Array([0x41, 0x42, 0x43]));
  });

  for (const text of [
    "QQ=",
    "Q===",
    "====",
    "QU=D",
    "QUJD!A==",
    "QUJ-",
    "QUJD\n",
  ]) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      assert.equal(decodeBase64(text), null);
    });
  }
});
