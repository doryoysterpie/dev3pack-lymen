// Solana Pay transfer request card fields (E-08). Pure module.
//
// It does not parse the URL itself: classify.ts (E-04) is the one place that
// parses and checks a Solana Pay URL, and this module reads the fields and the
// problem it returns. The one rule added here is the SPL token decimal check,
// which needs the mint's decimals.

import { classifyQr, type SolanaPayProblem } from "../qr/classify.ts";
import {
  recipientStatus,
  type RecipientLists,
  type RecipientStatus,
} from "./recipient-lists.ts";

export type TransferToken =
  { readonly kind: "sol" } | { readonly kind: "spl"; readonly mint: string };

/**
 * no-amount: the request leaves the amount to the wallet.
 * within-decimals: the amount has no more decimal places than the token allows.
 * decimals-not-checked: an SPL token amount whose mint decimals are not known.
 */
export type AmountCheck =
  "no-amount" | "within-decimals" | "decimals-not-checked";

export interface TransferCard {
  readonly recipient: string;
  readonly recipientStatus: RecipientStatus;
  readonly amount: string | null;
  readonly amountCheck: AmountCheck;
  readonly token: TransferToken;
  readonly references: readonly string[];
  readonly label: string | null;
  readonly message: string | null;
  readonly memo: string | null;
}

/** The classifier's transfer request problems, and anything that is not one. */
export type TransferProblem =
  | "not-a-transfer-request"
  | Extract<
      SolanaPayProblem,
      | "too-long"
      | "query-invalid"
      | "recipient-invalid"
      | "duplicate-field"
      | "amount-invalid"
      | "amount-too-precise"
      | "spl-token-invalid"
      | "reference-invalid"
    >;

export type TransferCardResult =
  | { readonly ok: true; readonly card: TransferCard }
  | { readonly ok: false; readonly problem: TransferProblem };

const TRANSFER_PROBLEMS: ReadonlySet<SolanaPayProblem> = new Set([
  "too-long",
  "query-invalid",
  "recipient-invalid",
  "duplicate-field",
  "amount-invalid",
  "amount-too-precise",
  "spl-token-invalid",
  "reference-invalid",
]);

function refuse(problem: TransferProblem): TransferCardResult {
  return { ok: false, problem };
}

function decimalPlaces(amount: string): number {
  const point = amount.indexOf(".");
  return point === -1 ? 0 : amount.length - point - 1;
}

/**
 * Which kind of Solana Pay request a solana: URL is, by its pathname alone, by
 * the rules the classifier (classify.ts, classifySolanaPay) and the reference
 * parseURL apply: a pathname that holds ":" or "%" is a transaction request
 * link, any other non-empty pathname a transfer request. An empty pathname,
 * with no recipient and no link, is neither, and so is text that is not a URL:
 * both give null. The classifier refuses a URL over 2048 characters before it
 * tells the kinds apart, so the card asks here.
 */
export function requestKind(text: string): "transfer" | "transaction" | null {
  let pathname: string;
  try {
    pathname = new URL(text).pathname;
  } catch {
    return null;
  }
  if (pathname === "") return null;
  return /[:%]/.test(pathname) ? "transaction" : "transfer";
}

/**
 * Builds the transfer card for the text of a scanned QR. mintDecimals is the
 * SPL mint's decimals when the caller knows them, or null. The spec has the
 * wallet reject an amount with more decimal places than the token supports;
 * the classifier already did so for SOL.
 */
export function transferCard(
  text: string,
  lists: RecipientLists,
  mintDecimals: number | null = null,
): TransferCardResult {
  const qr = classifyQr(text);
  if (qr.type === "other" && qr.reason === "malformed-solana-pay") {
    // A long request is a transfer request only when its pathname says so.
    if (qr.problem === "too-long" && requestKind(text) !== "transfer") {
      return refuse("not-a-transfer-request");
    }
    return TRANSFER_PROBLEMS.has(qr.problem)
      ? refuse(qr.problem as TransferProblem)
      : refuse("not-a-transfer-request");
  }
  if (qr.type !== "solana-pay" || qr.request !== "transfer") {
    return refuse("not-a-transfer-request");
  }

  let amountCheck: AmountCheck;
  if (qr.amount === null) {
    amountCheck = "no-amount";
  } else if (qr.splToken === null) {
    amountCheck = "within-decimals";
  } else if (mintDecimals === null) {
    amountCheck = "decimals-not-checked";
  } else if (decimalPlaces(qr.amount) > mintDecimals) {
    return refuse("amount-too-precise");
  } else {
    amountCheck = "within-decimals";
  }

  return {
    ok: true,
    card: {
      recipient: qr.recipient,
      recipientStatus: recipientStatus(qr.recipient, lists),
      amount: qr.amount,
      amountCheck,
      token:
        qr.splToken === null
          ? { kind: "sol" }
          : { kind: "spl", mint: qr.splToken },
      references: qr.references,
      label: qr.label,
      message: qr.message,
      memo: qr.memo,
    },
  };
}
