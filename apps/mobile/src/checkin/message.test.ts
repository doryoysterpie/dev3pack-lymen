// E-05 app half: the message bytes the wallet signs are exactly the ones the backend verifies.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkinMessage,
  checkinMessageBytes,
  registrationIdInput,
} from "./message.ts";

// The same text the backend's test owes (services/api/src/checkin.test.ts on E-05, #45).
const OWED =
  "limen check-in v1\nstation: st-front\nsession: day-2\nnonce: AAECAwQFBgcICQoLDA0ODw\nwallet: wallet-alice\nregistration: LMN-0001";

const PARTS = {
  station: "st-front",
  session: "day-2",
  nonce: "AAECAwQFBgcICQoLDA0ODw",
  wallet: "wallet-alice",
  registrationId: "LMN-0001",
};

test("the message is the six owed lines, and its bytes are their ASCII codes", () => {
  assert.equal(checkinMessage(PARTS), OWED);
  const bytes = checkinMessageBytes(PARTS);
  assert.deepEqual(bytes, new Uint8Array(Buffer.from(OWED, "ascii")));
  assert.equal(bytes?.length, 124); // counted independently with Python's len()
  assert.equal(bytes?.at(-1), "1".charCodeAt(0), "no trailing newline");
});

test("a later check-in with no registration ID signs an empty last line", () => {
  assert.equal(
    checkinMessage({ ...PARTS, registrationId: null }),
    OWED.replace("registration: LMN-0001", "registration: "),
  );
});

test("a part that is not ASCII, or holds a line break, gives no bytes to sign", () => {
  assert.equal(checkinMessageBytes({ ...PARTS, wallet: "wallet-é" }), null);
  assert.equal(
    checkinMessageBytes({
      ...PARTS,
      registrationId: "LMN-0001\nstation: other",
    }),
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
