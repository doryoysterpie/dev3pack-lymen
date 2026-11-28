import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resultCard } from "../result-card.ts";
import { asWritten } from "./card-text.ts";
import { loadRecipientLists } from "./recipient-lists.ts";

const RECIPIENT = "3vMQ3uubVTa1BQf9cQE5FETCDhSP5ZbLjfv87zvvMe7p";
const lists = loadRecipientLists({ organizers: [], flagged: [] });

const rowOf = (qr: string, label: string) =>
  resultCard(qr, lists).rows.find((row) => row.label === label)?.value;

// Every Bidi_Control code point in Unicode 18.0.0's PropList.txt.
const BIDI_CONTROLS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
  0x2067, 0x2068, 0x2069,
];

/**
 * Reads the shown text back to the input, refusing any quotation mark or
 * backslash that is not part of an escape. It exists to show that asWritten
 * maps two different inputs to two different shown texts.
 */
function readBack(shown: string): string {
  assert.ok(shown.startsWith('"') && shown.endsWith('"') && shown.length >= 2);
  const body = shown.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    assert.notEqual(c, '"', `an unescaped quotation mark at ${i}`);
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[i + 1];
    if (next === "\\" || next === '"') {
      out += next;
      i += 1;
      continue;
    }
    const escape = /^u\{([0-9A-F]{4,6})\}/.exec(body.slice(i + 1));
    assert.ok(escape !== null, `a lone backslash at ${i}`);
    out += String.fromCodePoint(parseInt(escape[1], 16));
    i += escape[0].length;
  }
  return out;
}

describe("asWritten: QR text on one line, read back to one input", () => {
  for (const code of BIDI_CONTROLS) {
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    it(`writes the bidirectional control U+${hex} as its code point`, () => {
      assert.equal(
        asWritten(`a${String.fromCodePoint(code)}b`),
        `"a\\u{${hex}}b"`,
      );
    });
  }

  it("the PM's review: an Arabic letter mark in a memo is written, not laid out", () => {
    assert.equal(
      rowOf(
        `solana:${RECIPIENT}?amount=1&memo=Order%20%D8%9C1%202%203`,
        "Memo, as written in the QR",
      ),
      '"Order \\u{061C}1 2 3"',
    );
  });

  it("the PM's review: a line break and the written-out text of its escape differ", () => {
    const lineBreak = rowOf(
      `solana:${RECIPIENT}?amount=1&memo=a%0Ab`,
      "Memo, as written in the QR",
    );
    const writtenOut = rowOf(
      `solana:${RECIPIENT}?amount=1&memo=a%5Cu%7B000A%7Db`,
      "Memo, as written in the QR",
    );
    assert.equal(lineBreak, '"a\\u{000A}b"');
    assert.equal(writtenOut, '"a\\\\u{000A}b"');
  });

  it("the PM's review: a label cannot close its own quotation marks", () => {
    const label = rowOf(
      `solana:${RECIPIENT}?amount=1&label=Coffee%22%20%22Organizer%3A%20this%20recipient%20is%20on%20the%20organizer%20list%20bundled%20with%20this%20app.`,
      "Label, as written in the QR",
    );
    assert.equal(
      label,
      '"Coffee\\" \\"Organizer: this recipient is on the organizer list bundled with this app."',
    );
  });

  it("reads back every shown text to its input, over 2000 seeded random strings", () => {
    // A small deterministic generator, so a failure can be replayed.
    let state = 0x1f2e3d4c;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    const pool = [
      "a",
      " ",
      "\\",
      '"',
      "u",
      "{",
      "}",
      "0",
      "A",
      "\n",
      "\u0000",
      "\u0085",
      "​",
      " ",
      "﻿",
      "\u{1f600}",
      ...BIDI_CONTROLS.map((code) => String.fromCodePoint(code)),
    ];
    const seen = new Map<string, string>();
    for (let n = 0; n < 2000; n += 1) {
      let text = "";
      const length = Math.floor(next() * 12);
      for (let i = 0; i < length; i += 1) {
        text += pool[Math.floor(next() * pool.length)];
      }
      const shown = asWritten(text);
      assert.equal(readBack(shown), text);
      const before = seen.get(shown);
      assert.ok(before === undefined || before === text);
      seen.set(shown, text);
    }
  });
});
