import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { classifyQr, type QrClass } from "./classify.ts";

interface FixtureCase {
  readonly name: string;
  readonly text: string;
  readonly owed: QrClass;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/qr/e04-classify.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: readonly FixtureCase[] };

describe("E-04 done test: fixture QRs classify to the owed type", () => {
  it("holds ten fixture QRs, two of them malformed", () => {
    assert.equal(fixture.cases.length, 10);
    const malformed = fixture.cases.filter(
      (c) =>
        c.owed.type === "other" && c.owed.reason === "malformed-solana-pay",
    );
    assert.equal(malformed.length, 2);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      assert.deepEqual(classifyQr(c.text), c.owed);
    });
  }
});

describe("classifyQr edge cases", () => {
  const owed: ReadonlyArray<readonly [string, QrClass]> = [
    // Station QRs match the exact prefix and nothing else.
    ["limen:station:", { type: "station", text: "limen:station:" }],
    ["limen:station", { type: "other", reason: "unrecognized" }],
    ["LIMEN:STATION:abc", { type: "other", reason: "unrecognized" }],
    [" limen:station:abc", { type: "other", reason: "unrecognized" }],
    // Text that is not an http, https or solana URL.
    ["", { type: "other", reason: "unrecognized" }],
    ["javascript:alert(1)", { type: "other", reason: "unrecognized" }],
    ["ftp://example.com/file", { type: "other", reason: "unrecognized" }],
    ["https://", { type: "other", reason: "unrecognized" }],
    // URL schemes are case-insensitive, so the parser lowercases them.
    [
      "SOLANA:11111111111111111111111111111111",
      {
        type: "solana-pay",
        request: "transfer",
        recipient: "11111111111111111111111111111111",
      },
    ],
    ["HTTPS://EXAMPLE.COM", { type: "url", href: "https://example.com/" }],
    // Malformed Solana Pay URLs.
    ["solana:", { type: "other", reason: "malformed-solana-pay" }],
    ["solana://host/path", { type: "other", reason: "malformed-solana-pay" }],
    // 31 bytes and 33 bytes: base58 that is not a 32-byte public key.
    [
      "solana:1111111111111111111111111111111",
      { type: "other", reason: "malformed-solana-pay" },
    ],
    [
      "solana:111111111111111111111111111111111",
      { type: "other", reason: "malformed-solana-pay" },
    ],
    ["solana:https%3A%2F%2", { type: "other", reason: "malformed-solana-pay" }],
    [
      "solana:ftp%3A%2F%2Fexample.com",
      { type: "other", reason: "malformed-solana-pay" },
    ],
  ];

  for (const [text, expected] of owed) {
    it(JSON.stringify(text), () => {
      assert.deepEqual(classifyQr(text), expected);
    });
  }
});
