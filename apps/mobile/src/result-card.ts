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
  const qr = classifyQr(text);
  if (qr.type === "solana-pay" && qr.request === "transfer") {
    // The app does not look up SPL mint decimals, so it passes null and the
    // card says the decimals were not checked.
    const result = transferCard(text, lists, null);
    return result.ok
      ? transferCardText(result.card)
      : transferProblemText(result.problem);
  }
  const summary = describeQr(qr);
  const malformed = qr.type === "other" && qr.reason === "malformed-solana-pay";
  return {
    title: summary.title,
    tone: malformed ? "malformed" : "neutral",
    status: summary.detail,
    rows: [],
  };
}
