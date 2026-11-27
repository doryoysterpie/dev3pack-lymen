// Chainabuse escalation (E-13), behind a feature flag that is off by default.
//
//   CHAINABUSE_POST unset or "off": nothing is built, logged or sent.
//   CHAINABUSE_POST "dry-run": when a case escalates, the request limen would send to Chainabuse
//     is built and its exact JSON body is logged. Nothing is sent and no credential is read.
//
// This unit has no live mode. The request follows Chainabuse's published OpenAPI definition
// for POST /v0/reports/batch (https://docs.chainabuse.com/reference/createreports, page updated
// 2025-09-08): an array of reports, each with scamCategory, description and addresses, plus the
// optional evidences. The body carries the case's domain, program IDs and recipients and the
// decoded simulation summary. It never carries transaction bytes, the QR text, device hashes or
// any reporter's wallet, even one the reporter chose to include in their report.
import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, loadBundle, type StoredBundle } from "./evidence.ts";
import { loadCase, type CaseView, type DomainLists } from "./triage.ts";

export const CHAINABUSE_REPORTS_URL =
  "https://api.chainabuse.com/v0/reports/batch";

export type ChainabuseMode = "off" | "dry-run";

/** Reads CHAINABUSE_POST. Unset or "off" is off; "dry-run" logs; anything else is refused. */
export function parseChainabuseMode(value: string | undefined): ChainabuseMode {
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "dry-run") return "dry-run";
  throw new Error(
    `CHAINABUSE_POST must be "off" or "dry-run", got "${value}". This build has no live mode.`,
  );
}

export type ChainabuseAddress =
  | { readonly chain: "SOL"; readonly address: string; readonly label: string }
  | { readonly domain: string; readonly label: string };

export interface ChainabuseReport {
  readonly scamCategory: "PHISHING";
  readonly description: string;
  readonly addresses: readonly ChainabuseAddress[];
  readonly evidences: readonly { readonly source: string }[];
}

export interface ChainabuseRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: { readonly "content-type": "application/json" };
  readonly body: readonly ChainabuseReport[];
}

/**
 * Escapes the inline markers of Chainabuse's markdown subset (bold, italic, strikethrough,
 * links) so report data renders as text, and folds line breaks into spaces. Report data only
 * ever appears mid-line, after "- key: ", so line-start markers (headings, lists) cannot apply.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_~[\]()]/g, (c) => `\\${c}`)
    .replace(/[\r\n]+/g, " ");
}

/** The bundle whose summary the report shows: the earliest re-simulation that reproduced a drain, else the latest bundle. */
function summaryBundle(
  bundles: readonly StoredBundle[],
): StoredBundle | undefined {
  const byId = [...bundles].sort((a, b) => a.sightingId - b.sightingId);
  return (
    byId.find(
      (b) => b.resimulation?.matches === true && b.resimulation.drainPattern,
    ) ?? byId[byId.length - 1]
  );
}

function summaryLines(summaryJson: string): string[] {
  const summary: unknown = JSON.parse(summaryJson);
  if (
    typeof summary === "object" &&
    summary !== null &&
    !Array.isArray(summary)
  ) {
    return Object.keys(summary)
      .sort()
      .map((key) => {
        const value = (summary as Record<string, unknown>)[key];
        const text = typeof value === "string" ? value : canonicalJson(value);
        return `- ${escapeMarkdown(key)}: ${escapeMarkdown(text)}`;
      });
  }
  return [`- ${escapeMarkdown(canonicalJson(summary))}`];
}

/**
 * Builds the Chainabuse request for an escalated case from the case and its stored bundles.
 * Throws when the case is not escalated, or has neither a domain nor a recipient to report.
 */
export function buildChainabuseRequest(
  view: CaseView,
  bundles: readonly StoredBundle[],
): ChainabuseRequest {
  if (view.status !== "escalated")
    throw new Error(`case ${view.id} is ${view.status}, not escalated`);
  const addresses: ChainabuseAddress[] = [
    ...(view.domain === null
      ? []
      : [{ domain: view.domain, label: "Domain of the reported QR link" }]),
    ...view.recipients.map((address) => ({
      chain: "SOL" as const,
      address,
      label: "Recipient in the simulated transaction",
    })),
  ];
  if (addresses.length === 0)
    throw new Error(`case ${view.id} has no domain or recipient to report`);

  const shown = summaryBundle(bundles);
  const reproduced =
    shown?.resimulation?.matches === true && shown.resimulation.drainPattern;
  const yesNo = (b: boolean) => (b ? "yes" : "no");
  const description = [
    "### limen escalation: simulated drain pattern",
    "",
    "A QR reported through limen leads to a transaction whose simulation shows funds leaving the signer's wallet. limen simulates on Solana devnet only.",
    "",
    `- Case: ${view.id}`,
    `- Decided by: ${view.decidedBy === "human" ? "human review" : "the automatic threshold (drain pattern, and two or more devices or a listed domain)"}`,
    `- Sightings: ${view.sightings}, from ${view.inputs.independentDevices} independent ${view.inputs.independentDevices === 1 ? "device" : "devices"}`,
    `- Domain: ${view.domain === null ? "none" : escapeMarkdown(view.domain)}`,
    `- Domain on the Phantom or PhishDestroy list: ${yesNo(view.inputs.domainListed)}`,
    `- Re-simulation reproduced the reported summary with a drain pattern: ${yesNo(reproduced)}`,
    "",
    "#### Simulated transaction summary",
    ...(shown === undefined
      ? ["- none stored"]
      : summaryLines(shown.summaryJson)),
    "",
    "#### Programs",
    ...(view.programIds.length === 0
      ? ["- none"]
      : view.programIds.map((p) => `- ${p}`)),
    "",
    "#### Recipients",
    ...(view.recipients.length === 0
      ? ["- none"]
      : view.recipients.map((r) => `- ${r}`)),
  ].join("\n");

  const evidences =
    shown === undefined
      ? []
      : [
          {
            source: `limen simulated transaction summary (Solana devnet): ${shown.summaryJson}`,
          },
        ];

  return {
    method: "POST",
    url: CHAINABUSE_REPORTS_URL,
    headers: { "content-type": "application/json" },
    body: [{ scamCategory: "PHISHING", description, addresses, evidences }],
  };
}

/**
 * The hook the report route calls when a case escalates. Off: undefined, so the route calls
 * nothing. Dry run: logs the request line and the exact JSON body that would be sent.
 */
export function chainabuseHook(
  mode: ChainabuseMode,
  db: DatabaseSync,
  lists: DomainLists,
  log: (line: string) => void,
): ((caseId: number) => void) | undefined {
  if (mode === "off") return undefined;
  return (caseId) => {
    const view = loadCase(db, caseId, lists);
    if (view === null) return;
    const ids = db
      .prepare("SELECT id FROM sightings WHERE case_id = ? ORDER BY id")
      .all(caseId) as { id: number }[];
    const bundles = ids
      .map((r) => loadBundle(db, r.id))
      .filter((b): b is StoredBundle => b !== null);
    const request = buildChainabuseRequest(view, bundles);
    log(
      `chainabuse dry run, not sent: ${request.method} ${request.url}\n${JSON.stringify(request.body)}`,
    );
  };
}
