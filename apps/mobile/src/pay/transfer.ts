// Solana Pay transfer request parsing and card fields (E-08). Pure module.
//
// Field rules follow the Solana Pay specification, "Specification: Transfer
// Request", and the reference parseURL in solana-foundation/pay at commit
// 8e1b87c (typescript/packages/solana-pay/core/src/parseURL.ts).

import { URL } from "whatwg-url-minimum";

import { decodePublicKey } from "../qr/base58.ts";
import { classifyQr } from "../qr/classify.ts";
import {
  recipientStatus,
  type RecipientLists,
  type RecipientStatus,
} from "./recipient-lists.ts";

/** The spec: SOL amounts may carry at most 9 decimal places. */
export const SOL_DECIMALS = 9;

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

export type TransferProblem =
  | "not-a-transfer-request"
  | "duplicate-field"
  | "amount-invalid"
  | "amount-too-precise"
  | "spl-token-invalid"
  | "reference-invalid";

export type TransferCardResult =
  | { readonly ok: true; readonly card: TransferCard }
  | { readonly ok: false; readonly problem: TransferProblem };

// The spec allows each of these fields once. A second copy is refused, because
// two wallets reading different copies would show different requests.
const SINGLE_FIELDS = ["amount", "spl-token", "label", "message", "memo"];

// The spec: a non-negative integer or decimal, with a leading 0 before the
// point when below 1, and no scientific notation. Same pattern as the
// reference parseURL.
const AMOUNT = /^\d+(\.\d+)?$/;

function refuse(problem: TransferProblem): TransferCardResult {
  return { ok: false, problem };
}

function decimalPlaces(amount: string): number {
  const point = amount.indexOf(".");
  return point === -1 ? 0 : amount.length - point - 1;
}

/**
 * Builds the transfer card for the text of a scanned QR. mintDecimals is the
 * SPL mint's decimals when the caller knows them, or null. The spec has the
 * wallet reject an amount with more decimal places than the token supports.
 */
export function transferCard(
  text: string,
  lists: RecipientLists,
  mintDecimals: number | null = null,
): TransferCardResult {
  const qr = classifyQr(text);
  if (qr.type !== "solana-pay" || qr.request !== "transfer") {
    return refuse("not-a-transfer-request");
  }

  const params = new URL(text).searchParams;
  for (const field of SINGLE_FIELDS) {
    if (params.getAll(field).length > 1) return refuse("duplicate-field");
  }

  const amount = params.get("amount");
  if (amount !== null && !AMOUNT.test(amount)) return refuse("amount-invalid");

  const mint = params.get("spl-token");
  if (mint !== null && decodePublicKey(mint) === null) {
    return refuse("spl-token-invalid");
  }

  const references = params.getAll("reference");
  if (references.some((reference) => decodePublicKey(reference) === null)) {
    return refuse("reference-invalid");
  }

  const allowedDecimals = mint === null ? SOL_DECIMALS : mintDecimals;
  let amountCheck: AmountCheck;
  if (amount === null) {
    amountCheck = "no-amount";
  } else if (allowedDecimals === null) {
    amountCheck = "decimals-not-checked";
  } else if (decimalPlaces(amount) > allowedDecimals) {
    return refuse("amount-too-precise");
  } else {
    amountCheck = "within-decimals";
  }

  return {
    ok: true,
    card: {
      recipient: qr.recipient,
      recipientStatus: recipientStatus(qr.recipient, lists),
      amount,
      amountCheck,
      token: mint === null ? { kind: "sol" } : { kind: "spl", mint },
      references,
      // As in the reference parseURL, an empty value counts as absent.
      label: params.get("label") || null,
      message: params.get("message") || null,
      memo: params.get("memo") || null,
    },
  };
}
