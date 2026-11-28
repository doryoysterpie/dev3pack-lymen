import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { loadRecipientLists, recipientStatus } from "./recipient-lists.ts";
import { transferCard, type TransferCardResult } from "./transfer.ts";

interface FixtureCase {
  readonly name: string;
  readonly text: string;
  readonly mintDecimals?: number;
  readonly owed: TransferCardResult;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/pay/e08-transfer.json", import.meta.url),
    "utf8",
  ),
) as { readonly lists: unknown; readonly cases: readonly FixtureCase[] };

const lists = loadRecipientLists(fixture.lists);

const ORGANIZER = "3vMQ3uubVTa1BQf9cQE5FETCDhSP5ZbLjfv87zvvMe7p";
const FLAGGED = "9tvU9qFD4Qiq3DFut32Bq1TgU3nEkrUqZdVy7ELe1uTD";

describe("E-08 done test: fixture URLs produce the owed card fields", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      assert.deepEqual(
        transferCard(c.text, lists, c.mintDecimals ?? null),
        c.owed,
      );
    });
  }

  it("an allowlisted recipient shows as organizer", () => {
    const result = transferCard(`solana:${ORGANIZER}?amount=1`, lists);
    assert.equal(result.ok && result.card.recipientStatus, "organizer");
  });

  it("a listed recipient shows as flagged", () => {
    const result = transferCard(`solana:${FLAGGED}?amount=1`, lists);
    assert.equal(result.ok && result.card.recipientStatus, "flagged");
  });
});

describe("recipient lists", () => {
  it("flags a recipient that is on both lists", () => {
    const both = loadRecipientLists({
      organizers: [FLAGGED],
      flagged: [FLAGGED],
    });
    assert.equal(recipientStatus(FLAGGED, both), "flagged");
  });

  it("refuses a list entry that is not a public key", () => {
    assert.throws(() =>
      loadRecipientLists({ organizers: ["not-a-key"], flagged: [] }),
    );
  });

  it("refuses lists with a missing field", () => {
    assert.throws(() => loadRecipientLists({ organizers: [] }));
    assert.throws(() => loadRecipientLists(null));
  });
});
