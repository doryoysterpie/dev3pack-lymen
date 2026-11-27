import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { resultCard } from "../result-card.ts";
import { loadRecipientLists, recipientStatus } from "./recipient-lists.ts";

// The lists the app ships, read from the same file App.tsx imports. The test
// owes every entry the file ships, so it fails if the file is emptied, loses an
// entry or gains one.
const shipped = loadRecipientLists(
  JSON.parse(
    readFileSync(new URL("./recipient-lists.json", import.meta.url), "utf8"),
  ),
);

// The devnet organizer public key Lane A made, as the PM gave it.
const ORGANIZER = "5zksGoSe5EEtAMwYMC4eUP8rJUXXdqWyNJudc8UtVrkV";
// The flagged address in fixtures/pay/e08-transfer.json, used by the demo.
const FLAGGED = "9tvU9qFD4Qiq3DFut32Bq1TgU3nEkrUqZdVy7ELe1uTD";
// The attacker in the E-09 fixtures (fixtures/tx), also flagged for the demo.
const FLAGGED_ATTACKER = "AadqUhBH5BtWcKCxnz9gfrWFCDBRXcdHQwzEsTqK49cK";
// Any other address.
const OTHER = "GsJrhpq3YeSBYmKAtkbQFjYN9EoLJvVJvfvs9pTQ84Hc";

describe("the lists the app ships", () => {
  it("ships exactly the owed entries", () => {
    assert.deepEqual([...shipped.organizers], [ORGANIZER]);
    assert.deepEqual([...shipped.flagged], [FLAGGED, FLAGGED_ATTACKER]);
  });

  it("shows the organizer key as organizer", () => {
    assert.equal(recipientStatus(ORGANIZER, shipped), "organizer");
    const card = resultCard(`solana:${ORGANIZER}?amount=1`, shipped);
    assert.equal(card.tone, "organizer");
    assert.equal(
      card.status,
      "Organizer: this recipient is on the organizer list bundled with this app.",
    );
  });

  for (const flagged of [FLAGGED, FLAGGED_ATTACKER]) {
    it(`shows the listed address ${flagged} as flagged`, () => {
      assert.equal(recipientStatus(flagged, shipped), "flagged");
      const card = resultCard(`solana:${flagged}?amount=1`, shipped);
      assert.equal(card.tone, "flagged");
      assert.equal(
        card.status,
        "Flagged: this recipient is on the devnet list of flagged addresses bundled with this app.",
      );
    });
  }

  it("shows any other address as on neither list", () => {
    assert.equal(recipientStatus(OTHER, shipped), "unlisted");
  });
});
