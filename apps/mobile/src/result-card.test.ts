import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadRecipientLists } from "./pay/recipient-lists.ts";
import { resultCard } from "./result-card.ts";

const ORGANIZER = "3vMQ3uubVTa1BQf9cQE5FETCDhSP5ZbLjfv87zvvMe7p";
const FLAGGED = "9tvU9qFD4Qiq3DFut32Bq1TgU3nEkrUqZdVy7ELe1uTD";
const lists = loadRecipientLists({
  organizers: [ORGANIZER],
  flagged: [FLAGGED],
});

describe("E-08 done test: what the transfer card shows", () => {
  it("shows an allowlisted recipient as organizer", () => {
    assert.deepEqual(
      resultCard(`solana:${ORGANIZER}?amount=2.5&label=Hack%20fee`, lists),
      {
        title: "Solana Pay transfer request",
        tone: "organizer",
        status: "Organizer: this recipient is on the event organizer list.",
        rows: [
          { label: "Recipient", value: ORGANIZER },
          { label: "Amount", value: "2.5 SOL" },
          { label: "Token", value: "SOL" },
          { label: "Label, as written in the QR", value: "Hack fee" },
        ],
      },
    );
  });

  it("shows a listed recipient as flagged", () => {
    assert.deepEqual(resultCard(`solana:${FLAGGED}?amount=10`, lists), {
      title: "Solana Pay transfer request",
      tone: "flagged",
      status:
        "Flagged: this recipient is on the devnet list of flagged addresses bundled with this app.",
      rows: [
        { label: "Recipient", value: FLAGGED },
        { label: "Amount", value: "10 SOL" },
        { label: "Token", value: "SOL" },
      ],
    });
  });

  it("says SPL token decimals were not checked, since the app passes none", () => {
    const mint = "EzamibQgq4KbhJm44Wx8dFP13xmDrXZX5hBLhrVJnYDT";
    const card = resultCard(
      `solana:${ORGANIZER}?amount=0.01&spl-token=${mint}`,
      lists,
    );
    assert.deepEqual(card.rows.slice(1, 3), [
      {
        label: "Amount",
        value: "0.01. The token's decimal places have not been checked.",
      },
      { label: "Token", value: `SPL token, mint ${mint}` },
    ]);
  });

  it("shows a malformed transfer request as malformed, with no fields", () => {
    assert.deepEqual(
      resultCard(`solana:${ORGANIZER}?amount=1&amount=100`, lists),
      {
        title: "Malformed Solana Pay transfer request",
        tone: "malformed",
        status:
          "limen flags this QR: it repeats a field that the Solana Pay format allows only once, so two wallets could read two different requests from it.",
        rows: [],
      },
    );
  });

  it("leaves other QR types to the E-04 summary", () => {
    assert.deepEqual(resultCard("https://example.org/schedule", lists), {
      title: "Web link",
      tone: "neutral",
      status:
        "Opens https://example.org/schedule. limen has not checked this link.",
      rows: [],
    });
  });
});
