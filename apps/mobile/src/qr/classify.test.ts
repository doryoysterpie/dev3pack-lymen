import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  classifyQr,
  type QrClass,
  type SolanaPayProblem,
  type TransferRequest,
} from "./classify.ts";

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

const R = "9MJAtNQnuUcAKm6LXbobqTRXySgScVyUEAavmPUhnP3k";
const MINT = "9FDVRcwfqnN19PRjaikWMfGKz9vt5YFa8r8h9Juj3qpw";
const REFERENCE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** A transfer request with every optional field absent, then overrides. */
function transfer(
  recipient: string,
  fields: Partial<Omit<TransferRequest, "type" | "request" | "recipient">> = {},
): QrClass {
  return {
    type: "solana-pay",
    request: "transfer",
    recipient,
    amount: null,
    splToken: null,
    references: [],
    label: null,
    message: null,
    memo: null,
    ...fields,
  };
}

function malformed(problem: SolanaPayProblem): QrClass {
  return { type: "other", reason: "malformed-solana-pay", problem };
}

// A transfer request padded with a label to an exact length.
function ofLength(length: number): string {
  const head = `solana:${R}?label=`;
  return head + "a".repeat(length - head.length);
}

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
      transfer("11111111111111111111111111111111"),
    ],
    ["HTTPS://EXAMPLE.COM", { type: "url", href: "https://example.com/" }],
    // Malformed pathnames.
    ["solana:", malformed("no-pathname")],
    ["solana://host/path", malformed("recipient-invalid")],
    // 31 bytes and 33 bytes: base58 that is not a 32-byte public key.
    ["solana:1111111111111111111111111111111", malformed("recipient-invalid")],
    [
      "solana:111111111111111111111111111111111",
      malformed("recipient-invalid"),
    ],
    ["solana:https%3A%2F%2", malformed("link-invalid")],
    ["solana:ftp%3A%2F%2Fexample.com", malformed("link-invalid")],
    // The amount: a non-negative integer or decimal, a leading 0 below 1, no
    // scientific notation (SPEC.md, "Amount"; the reference pattern).
    [`solana:${R}?amount=0`, transfer(R, { amount: "0" })],
    [`solana:${R}?amount=-1`, malformed("amount-invalid")],
    [`solana:${R}?amount=1e9`, malformed("amount-invalid")],
    [`solana:${R}?amount=.5`, malformed("amount-invalid")],
    [`solana:${R}?amount=1.`, malformed("amount-invalid")],
    [`solana:${R}?amount=`, malformed("amount-invalid")],
    [`solana:${R}?amount=%201`, malformed("amount-invalid")],
    // At most 9 decimal places for SOL. An SPL amount's places are not checked
    // here: the mint's decimals are not in the URL.
    [`solana:${R}?amount=0.000000001`, transfer(R, { amount: "0.000000001" })],
    [`solana:${R}?amount=0.0000000001`, malformed("amount-too-precise")],
    [
      `solana:${R}?amount=0.0000000001&spl-token=${MINT}`,
      transfer(R, { amount: "0.0000000001", splToken: MINT }),
    ],
    // spl-token and every reference must be a 32-byte base58 value.
    [`solana:${R}?spl-token=not-a-mint`, malformed("spl-token-invalid")],
    [`solana:${R}?spl-token=`, malformed("spl-token-invalid")],
    [`solana:${R}?reference=0OIl`, malformed("reference-invalid")],
    [
      `solana:${R}?reference=${REFERENCE}&reference=1111`,
      malformed("reference-invalid"),
    ],
    [
      `solana:${R}?reference=${REFERENCE}&reference=${MINT}`,
      transfer(R, { references: [REFERENCE, MINT] }),
    ],
    // Fields the spec allows once.
    [`solana:${R}?amount=1&amount=2`, malformed("duplicate-field")],
    [`solana:${R}?memo=a&memo=b`, malformed("duplicate-field")],
    // Label, message and memo are URL-decoded; an empty one counts as absent.
    [
      `solana:${R}?label=Build%20Station&message=&memo=Order%2042`,
      transfer(R, { label: "Build Station", memo: "Order 42" }),
    ],
    [`solana:${R}?label=&message=Hi&memo=`, transfer(R, { message: "Hi" })],
    // Fields are decoded with decodeURIComponent, as SPEC.md links: a "+"
    // stays a "+" (form decoding would make it a space), escapes decode, and a
    // field that is not valid percent-encoding is refused.
    [
      `solana:${R}?memo=A+B&label=C%2BD`,
      transfer(R, { memo: "A+B", label: "C+D" }),
    ],
    [
      `solana:${R}?label=Coffee%0A%0AOrganizer%3A%20x`,
      transfer(R, { label: "Coffee\n\nOrganizer: x" }),
    ],
    [`solana:${R}?label=caf%C3%A9%20bar`, transfer(R, { label: "café bar" })],
    [`solana:${R}?label=a%ZZ`, malformed("query-invalid")],
    [`solana:${R}?memo=%E0%A4%A`, malformed("query-invalid")],
    // The reference parseURL refuses a URL string past 2048 characters.
    [
      ofLength(2048),
      transfer(R, { label: "a".repeat(2048 - `solana:${R}?label=`.length) }),
    ],
    [ofLength(2049), malformed("too-long")],
  ];

  for (const [text, expected] of owed) {
    it(
      text.length > 80
        ? `${text.slice(0, 60)}... (${text.length} characters)`
        : JSON.stringify(text),
      () => {
        assert.deepEqual(classifyQr(text), expected);
      },
    );
  }
});
