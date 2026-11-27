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
        status:
          "Organizer: this recipient is on the organizer list bundled with this app.",
        rows: [
          { label: "Recipient", value: ORGANIZER },
          { label: "Amount", value: "2.5 SOL" },
          { label: "Token", value: "SOL" },
          {
            label: "Label, as written in the QR",
            value: '"Hack fee"',
            quoted: true,
          },
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

  it("keeps a memo that imitates the status line on one quoted line, apart", () => {
    const imitation =
      "Coffee%0A%0AOrganizer%3A%20this%20recipient%20is%20on%20the%20organizer%20list%20bundled%20with%20this%20app.";
    const card = resultCard(
      `solana:${FLAGGED}?amount=1&memo=${imitation}`,
      lists,
    );
    assert.equal(card.tone, "flagged");
    assert.deepEqual(card.rows.at(-1), {
      label: "Memo, as written in the QR",
      value:
        '"Coffee\\u{000A}\\u{000A}Organizer: this recipient is on the organizer list bundled with this app."',
      quoted: true,
    });
    assert.ok(
      card.rows.every((row) => !row.value.includes("\n") || !row.quoted),
    );
  });

  it("shows a + in the memo as the + a spec-following wallet writes", () => {
    const card = resultCard(`solana:${ORGANIZER}?amount=1&memo=A+B`, lists);
    assert.deepEqual(card.rows.at(-1), {
      label: "Memo, as written in the QR",
      value: '"A+B"',
      quoted: true,
    });
  });

  it("says only that no amount is in the request", () => {
    const card = resultCard(`solana:${ORGANIZER}`, lists);
    assert.deepEqual(card.rows[1], {
      label: "Amount",
      value: "Not in the request.",
    });
  });

  it("states the spec's amount rule when the amount is written wrong", () => {
    assert.equal(
      resultCard(`solana:${ORGANIZER}?amount=.5`, lists).status,
      "limen flags this QR: its amount is not written as the Solana Pay format requires: digits, then at most one point followed by digits, with no sign and no exponent, so an amount below 1 starts with 0.",
    );
  });

  it("titles a request over 2048 characters by its kind", () => {
    const status =
      "limen flags this QR: it is longer than the 2048 characters the Solana Pay reference parser accepts.";
    // The PM's review: a transaction request link with 2100 letters after it.
    const link = `solana:https%3A%2F%2Fexample.com%2Fpay%3Fq%3D${"a".repeat(2100)}`;
    assert.equal(link.length, 2145);
    assert.deepEqual(resultCard(link, lists), {
      title: "Malformed Solana Pay transaction request",
      tone: "malformed",
      status,
      rows: [],
    });
    const transfer = `solana:${ORGANIZER}?label=${"a".repeat(2100)}`;
    assert.deepEqual(resultCard(transfer, lists), {
      title: "Malformed Solana Pay transfer request",
      tone: "malformed",
      status,
      rows: [],
    });
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
