// E-05 app half: the message bytes the wallet signs are exactly the ones the backend verifies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  checkinMessage,
  checkinMessageBytes,
  registrationIdInput,
} from "./message.ts";

// The same text the backend's test owes (services/api/src/checkin.test.ts on E-05-held, PR #60, 56ed8c6).
const OWED =
  "limen check-in v2\nstation: st-front\nsession: day-2\nnonce: AAECAwQFBgcICQoLDA0ODw\nwallet: wallet-alice";

const PARTS = {
  station: "st-front",
  session: "day-2",
  nonce: "AAECAwQFBgcICQoLDA0ODw",
  wallet: "wallet-alice",
};

test("the message is the five owed lines with no registration ID, and its bytes are their ASCII codes", () => {
  const text = checkinMessage(PARTS);
  assert.equal(text, OWED);
  assert.doesNotMatch(text, /registration/i);
  const bytes = checkinMessageBytes(PARTS);
  assert.deepEqual(bytes, new Uint8Array(Buffer.from(OWED, "ascii")));
  assert.equal(bytes?.length, 101); // counted independently with Buffer.byteLength
  assert.equal(bytes?.at(-1), "e".charCodeAt(0), "no trailing newline");
});

test("a part that is not ASCII, or holds a line break, gives no bytes to sign", () => {
  assert.equal(checkinMessageBytes({ ...PARTS, wallet: "wallet-é" }), null);
  assert.equal(
    checkinMessageBytes({ ...PARTS, wallet: "wallet-alice\nstation: other" }),
    null,
  );
  assert.equal(checkinMessageBytes({ ...PARTS, station: "st\rfront" }), null);
});

test("a typed registration ID is trimmed, and refused unless 1 to 64 ASCII letters, digits, _ or -", () => {
  assert.equal(registrationIdInput("  LMN-0001 "), "LMN-0001");
  assert.equal(registrationIdInput("lmn-0001"), "lmn-0001");
  for (const bad of ["", "   ", "LMN 0001", "lmn-ſ1", "x".repeat(65)]) {
    assert.equal(registrationIdInput(bad), null, JSON.stringify(bad));
  }
});

test("the app check-in README and message test point to backend PR #60, not #45", () => {
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const self = readFileSync(new URL(import.meta.url), "utf8");
  assert.match(readme, /\(PR #60\)/);
  assert.doesNotMatch(readme, /#45\b/);
  assert.match(self, /E-05-held, PR #60/);
  // Strip this test's own assertion literal before checking the rest of the file.
  const headerOnly = self.slice(
    0,
    self.indexOf('test("the app check-in README'),
  );
  assert.doesNotMatch(headerOnly, /#45\b|on E-05,/);
});
