// The card the app shows for a scanned QR. Pure module, so the choice of card
// is tested in Node.

import {
  transferCardText,
  transferProblemText,
  type CardText,
} from "./pay/card-text.ts";
import type { RecipientLists } from "./pay/recipient-lists.ts";
import { transferCard } from "./pay/transfer.ts";
import { classifyQr } from "./qr/classify.ts";
import { describeQr } from "./qr/describe.ts";

export function resultCard(text: string, lists: RecipientLists): CardText {
  // The app does not look up SPL mint decimals, so it passes null and the
  // card says the decimals were not checked.
  const transfer = transferCard(text, lists, null);
  if (transfer.ok) return transferCardText(transfer.card);
  if (transfer.problem !== "not-a-transfer-request") {
    return transferProblemText(transfer.problem);
  }

  const qr = classifyQr(text);
  const summary = describeQr(qr);
  const malformed = qr.type === "other" && qr.reason === "malformed-solana-pay";
  return {
    title: summary.title,
    tone: malformed ? "malformed" : "neutral",
    status: summary.detail,
    rows: [],
  };
}
