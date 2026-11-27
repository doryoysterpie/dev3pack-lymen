// Result-card text for each QR class. App strings live here so the copy
// rules (rule 9) can be checked in one place.

import type { QrClass } from "./classify.ts";

export interface QrSummary {
  readonly title: string;
  readonly detail: string;
}

export function describeQr(result: QrClass): QrSummary {
  switch (result.type) {
    case "station":
      return {
        title: "Station check-in QR",
        detail:
          "This QR starts like a limen station QR. Its signature has not been checked.",
      };
    case "solana-pay":
      return result.request === "transfer"
        ? {
            title: "Solana Pay transfer request",
            detail: `Asks you to send a payment to ${result.recipient}. limen has not checked this recipient.`,
          }
        : {
            title: "Solana Pay transaction request",
            detail: `Asks ${result.link} for a transaction to sign. limen has not fetched or simulated it.`,
          };
    case "url":
      return {
        title: "Web link",
        detail: `Opens ${result.href}. limen has not checked this link.`,
      };
    case "other":
      return result.reason === "malformed-solana-pay"
        ? {
            title: "Malformed Solana Pay request",
            detail:
              "limen flags this QR: it starts like a Solana Pay request but does not follow the Solana Pay format.",
          }
        : {
            title: "Unrecognized QR",
            detail:
              "This QR is not a limen station QR, a Solana Pay request or a web link.",
          };
  }
}
