// Transfer-request card text (E-08). App strings live here so the copy rules
// (rule 9) can be checked in one place.

import type { RecipientStatus } from "./recipient-lists.ts";
import type { TransferCard, TransferProblem } from "./transfer.ts";

export interface CardRow {
  readonly label: string;
  readonly value: string;
}

/** organizer and flagged come from the recipient lists; neutral is everything else. */
export type Tone = "organizer" | "flagged" | "malformed" | "neutral";

export interface CardText {
  readonly title: string;
  readonly tone: Tone;
  readonly status: string;
  readonly rows: readonly CardRow[];
}

// "Flagged" means on the devnet list bundled with this app, and nothing wider:
// no string here may suggest a check against real scam reports.
const STATUS: Readonly<Record<RecipientStatus, string>> = {
  organizer: "Organizer: this recipient is on the event organizer list.",
  flagged:
    "Flagged: this recipient is on the devnet list of flagged addresses bundled with this app.",
  unlisted:
    "This recipient is not on the organizer list or on the bundled devnet list of flagged addresses.",
};

const PROBLEM: Readonly<Record<TransferProblem, string>> = {
  "not-a-transfer-request": "it is not a Solana Pay transfer request.",
  "too-long":
    "it is longer than the 2048 characters the Solana Pay reference parser accepts.",
  "recipient-invalid": "its recipient is not a valid public key.",
  "duplicate-field":
    "it repeats a field that the Solana Pay format allows only once, so two wallets could read two different requests from it.",
  "amount-invalid": "its amount is not a plain non-negative number.",
  "amount-too-precise":
    "its amount has more decimal places than the token allows.",
  "spl-token-invalid": "its token mint is not a valid public key.",
  "reference-invalid": "one of its references is not a valid 32-byte value.",
};

function amountRow(card: TransferCard): CardRow {
  if (card.amount === null) {
    return {
      label: "Amount",
      value: "Not in the request. The wallet asks you for it.",
    };
  }
  const value = card.token.kind === "sol" ? `${card.amount} SOL` : card.amount;
  return {
    label: "Amount",
    value:
      card.amountCheck === "decimals-not-checked"
        ? `${value}. The token's decimal places have not been checked.`
        : value,
  };
}

export function transferCardText(card: TransferCard): CardText {
  const rows: CardRow[] = [
    { label: "Recipient", value: card.recipient },
    amountRow(card),
    {
      label: "Token",
      value:
        card.token.kind === "sol"
          ? "SOL"
          : `SPL token, mint ${card.token.mint}`,
    },
  ];
  // Label, message and memo come from the QR itself, so the card says so.
  if (card.label !== null) {
    rows.push({ label: "Label, as written in the QR", value: card.label });
  }
  if (card.message !== null) {
    rows.push({ label: "Message, as written in the QR", value: card.message });
  }
  if (card.memo !== null) {
    rows.push({ label: "Memo, as written in the QR", value: card.memo });
  }
  if (card.references.length > 0) {
    rows.push({ label: "References", value: card.references.join("\n") });
  }
  return {
    title: "Solana Pay transfer request",
    tone:
      card.recipientStatus === "unlisted" ? "neutral" : card.recipientStatus,
    status: STATUS[card.recipientStatus],
    rows,
  };
}

export function transferProblemText(problem: TransferProblem): CardText {
  return {
    title: "Malformed Solana Pay transfer request",
    tone: "malformed",
    status: `limen flags this QR: ${PROBLEM[problem]}`,
    rows: [],
  };
}
