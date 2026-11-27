// Transfer-request card text (E-08). App strings live here so the copy rules
// (rule 9) can be checked in one place.

import type { RecipientStatus } from "./recipient-lists.ts";
import type { TransferCard, TransferProblem } from "./transfer.ts";

export interface CardRow {
  readonly label: string;
  readonly value: string;
  /**
   * The value is text from the QR or the requester, not limen's own words.
   * The card draws it apart, quoted and in a box, so it cannot pass for a
   * status line.
   */
  readonly quoted?: boolean;
}

/** organizer and flagged come from the recipient lists; neutral is everything else. */
export type Tone = "organizer" | "flagged" | "malformed" | "neutral";

export interface CardText {
  readonly title: string;
  readonly tone: Tone;
  readonly status: string;
  readonly rows: readonly CardRow[];
}

// The statuses speak only of the two lists bundled with this app. "Flagged"
// means on the bundled devnet list, nothing wider: no string here may suggest a
// check against real scam reports.
const STATUS: Readonly<Record<RecipientStatus, string>> = {
  organizer:
    "Organizer: this recipient is on the organizer list bundled with this app.",
  flagged:
    "Flagged: this recipient is on the devnet list of flagged addresses bundled with this app.",
  unlisted:
    "This recipient is not on either list bundled with this app, the organizer list or the flagged list.",
};

const PROBLEM: Readonly<Record<TransferProblem, string>> = {
  "not-a-transfer-request": "it is not a Solana Pay transfer request.",
  "too-long":
    "it is longer than the 2048 characters the Solana Pay reference parser accepts.",
  "query-invalid": "one of its fields is not valid URL encoding.",
  "recipient-invalid": "its recipient is not a valid public key.",
  "duplicate-field":
    "it repeats a field that the Solana Pay format allows only once, so two wallets could read two different requests from it.",
  "amount-invalid":
    "its amount is not written as the Solana Pay format requires: digits, then at most one point followed by digits, with no sign and no exponent, so an amount below 1 starts with 0.",
  "amount-too-precise":
    "its amount has more decimal places than the token allows.",
  "spl-token-invalid": "its token mint is not a valid public key.",
  "reference-invalid": "one of its references is not a valid 32-byte value.",
};

// Characters that would break the text across lines or reorder it on screen:
// C0 and C1 controls (line breaks among them), zero-width marks, every
// Bidi_Control character in Unicode 18.0.0's PropList.txt (U+061C, U+200E and
// U+200F, U+202A to U+202E, U+2066 to U+2069), the line and paragraph
// separators, and the byte order mark.
function hidden(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Text from the QR, shown on one line between quotation marks, with each
 * character that would break or reorder the line written as its code point,
 * such as \u{000A} for a line break. A backslash is written \\ and a
 * quotation mark \", so the text cannot close its own quotes, and the shown
 * text reads back to exactly one input: every backslash in it starts one of
 * those three escapes.
 */
export function asWritten(text: string): string {
  let shown = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\" || character === '"') {
      shown += `\\${character}`;
    } else if (hidden(code)) {
      shown += `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}`;
    } else {
      shown += character;
    }
  }
  return `"${shown}"`;
}

function amountRow(card: TransferCard): CardRow {
  if (card.amount === null) {
    return {
      label: "Amount",
      value: "Not in the request.",
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
  // Label, message and memo come from the QR itself: the card says so, quotes
  // them on one line and draws them apart from limen's own text.
  const written: ReadonlyArray<readonly [string, string | null]> = [
    ["Label, as written in the QR", card.label],
    ["Message, as written in the QR", card.message],
    ["Memo, as written in the QR", card.memo],
  ];
  for (const [label, text] of written) {
    if (text !== null) {
      rows.push({ label, value: asWritten(text), quoted: true });
    }
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

/**
 * A solana: URL over the length limit that is not a transfer request: a
 * transaction request link, or, with no recipient and no link, neither kind.
 * The classifier refuses it before it tells the kinds apart; requestKind
 * (transfer.ts) names the kind.
 */
export function longRequestText(kind: "transaction" | null): CardText {
  return {
    title:
      kind === "transaction"
        ? "Malformed Solana Pay transaction request"
        : "Malformed Solana Pay request",
    tone: "malformed",
    status: `limen flags this QR: ${PROBLEM["too-long"]}`,
    rows: [],
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
