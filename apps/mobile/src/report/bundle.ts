// The evidence bundle the app sends with a report (E-10, app side). Pure module, so the
// bundle for a fixture drainer is tested in Node.
//
// The bundle follows the API's POST /reports format (services/api/src/evidence.ts on E-10):
// device_id, payload, url, transaction, simulation, summary, program_ids, recipients,
// timestamp and app_version, and wallet with include_wallet only when the reporter opts in.
// The transaction bytes still name the signing wallet as an account key: the server needs
// them whole to re-simulate.

import type { Preflight } from "../tx/preflight.ts";
import type { Effect, Place, TransactionSummary } from "../tx/summary.ts";
import type { ParsedTransaction } from "../tx/wire.ts";

/**
 * The summary as the bundle carries it: the pre-flight summary with each instruction the
 * wallet does not authorize cut to its index and kind, the form the E-09 fixtures owe.
 */
export interface ReportSummary {
  readonly effects: readonly Effect[];
  readonly others: readonly {
    readonly instruction: number;
    readonly kind: string;
  }[];
  readonly undecoded: TransactionSummary["undecoded"];
  readonly signers: TransactionSummary["signers"];
  readonly unresolvedAccounts: number;
}

export interface ReportBundle {
  readonly device_id: string;
  readonly payload: string;
  readonly url: string;
  readonly transaction: string;
  /** The pre-flight does not keep the simulation's slot and blockhash yet, so this is null. */
  readonly simulation: null;
  readonly summary: ReportSummary;
  readonly program_ids: readonly string[];
  readonly recipients: readonly string[];
  readonly timestamp: number;
  readonly app_version: string;
  readonly include_wallet?: true;
  readonly wallet?: string;
}

export type ReadyPreflight = Extract<Preflight, { kind: "ready" }>;

export interface ReportInput {
  readonly preflight: ReadyPreflight;
  /** The scanned QR text. */
  readonly qrText: string;
  /** The transaction request's https link. */
  readonly link: string;
  /** The user's wallet address, which the pre-flight ran for. */
  readonly user: string;
  /** Sent only when true. */
  readonly includeWallet: boolean;
  readonly deviceId: string;
  /** Unix time in whole seconds. */
  readonly timestamp: number;
  readonly appVersion: string;
}

export function reportSummary(summary: TransactionSummary): ReportSummary {
  return {
    effects: summary.effects,
    others: summary.others.map(({ instruction, decoded }) => ({
      instruction,
      kind: decoded.kind,
    })),
    undecoded: summary.undecoded,
    signers: summary.signers,
    unresolvedAccounts: summary.unresolvedAccounts,
  };
}

const sortedUnique = (list: readonly string[]): string[] =>
  [...new Set(list)].sort();

/** The program each instruction calls, sorted and deduplicated. */
export function programIds(transaction: ParsedTransaction): string[] {
  const { staticKeys, instructions } = transaction.message;
  return sortedUnique(
    instructions.flatMap(({ programIdIndex }) => {
      const key = staticKeys[programIdIndex];
      return key === undefined ? [] : [key];
    }),
  );
}

function addressOf(place: Place): string[] {
  return "address" in place ? [place.address] : [];
}

/** Where an effect sends value or control, when the address is known. */
function receivers(effect: Effect): string[] {
  switch (effect.kind) {
    case "sol-out":
      return addressOf(effect.to);
    case "owner-assigned":
      return [effect.newOwner];
    case "token-out":
      return addressOf(effect.destination);
    case "delegate-approved":
      return addressOf(effect.delegate);
    case "authority-changed":
      return effect.newAuthority === null ? [] : [effect.newAuthority];
    case "account-closed":
      return addressOf(effect.destination);
    case "pays-for-token-account":
    case "delegate-revoked":
    case "tokens-burned":
      return [];
  }
}

/**
 * The addresses the transaction would send the user's value or control to, sorted and
 * deduplicated, never including the user's own wallet.
 */
export function recipients(
  summary: TransactionSummary,
  user: string,
): string[] {
  return sortedUnique(summary.effects.flatMap(receivers)).filter(
    (address) => address !== user,
  );
}

export function buildReport(input: ReportInput): ReportBundle {
  const { preflight } = input;
  const bundle: ReportBundle = {
    device_id: input.deviceId,
    payload: input.qrText,
    url: input.link,
    transaction: preflight.base64,
    simulation: null,
    summary: reportSummary(preflight.summary),
    program_ids: programIds(preflight.transaction),
    recipients: recipients(preflight.summary, input.user),
    timestamp: input.timestamp,
    app_version: input.appVersion,
  };
  return input.includeWallet
    ? { ...bundle, include_wallet: true, wallet: input.user }
    : bundle;
}
