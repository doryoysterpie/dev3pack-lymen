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
// decoded simulation summary. The builder never reads a bundle's transaction bytes, QR text,
// device hash or wallet field. The summary comes from the reporter's app, so redactSummary
// leaves out every value in it that names an address other than the case's recipients and
// program IDs, and every feePayer, at any depth, that is not the role marker "user", before any
// of it goes into the body.
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

/** A run of base58 characters as long as a Solana address, or longer. */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/g;

function namesUnlisted(text: string, listed: ReadonlySet<string>): boolean {
  return (text.match(BASE58_RUN) ?? []).some((run) => !listed.has(run));
}

const LEFT_OUT = Symbol("left out");

/**
 * The summary as the body may show it. The summary is the reporter's app's, so it is not
 * trusted to keep the reporter's wallet out. Left out:
 *   - every string, array item or object entry that names an address other than the listed
 *     ones (the case's recipients and program IDs). An address is any run of 32 or more base58
 *     characters, the form a Solana address takes, and a run is kept only when it is exactly a
 *     listed address. An entry whose key names such an address is left out whole;
 *   - every entry named feePayer, at any depth, unless it is exactly the role marker "user" that
 *     E-09 writes there. E-09's summary has it at signers.feePayer, and its full report at
 *     summary.signers.feePayer; a feePayer anywhere else is left out on the same terms.
 * Returns what is kept and how many values were left out.
 */
export function redactSummary(
  summary: unknown,
  listed: ReadonlySet<string>,
): { readonly summary: unknown; readonly leftOut: number } {
  let leftOut = 0;
  const keep = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!namesUnlisted(value, listed)) return value;
      leftOut++;
      return LEFT_OUT;
    }
    if (Array.isArray(value))
      return value.map(keep).filter((v) => v !== LEFT_OUT);
    if (typeof value !== "object" || value === null) return value;
    const kept: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (namesUnlisted(key, listed) || (key === "feePayer" && v !== "user")) {
        leftOut++;
        continue;
      }
      const k = keep(v);
      if (k !== LEFT_OUT) kept[key] = k;
    }
    return kept;
  };
  const kept = keep(summary);
  return { summary: kept === LEFT_OUT ? undefined : kept, leftOut };
}

function summaryLines(summary: unknown): string[] {
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

/** Why no request was built for a case. Its message names no report data. */
export class NothingToReport extends Error {}

/**
 * Whether the simulation recorded in a stored report ran without an error: "clean", "not
 * clean" when it failed or did not run, or null when the report records none. E-09 writes it
 * as the report's top-level `simulation`, { status: "ran", err, changes } or { status:
 * "not-run", reason }, and counts a simulation toward a drain pattern only when it ran with err
 * null (packages/preflight/src/drain.ts).
 */
function simulationOutcome(summary: unknown): "clean" | "not clean" | null {
  if (typeof summary !== "object" || summary === null) return null;
  const sim = (summary as Record<string, unknown>).simulation;
  if (typeof sim !== "object" || sim === null) return null;
  const { status, err } = sim as Record<string, unknown>;
  if (status === "ran") return err === null ? "clean" : "not clean";
  if (status === "not-run") return "not clean";
  return null;
}

/**
 * Builds the Chainabuse request for an escalated case from the case and its stored bundles.
 * Throws NothingToReport when the case is not escalated, or has neither a domain nor a
 * recipient to report.
 */
export function buildChainabuseRequest(
  view: CaseView,
  bundles: readonly StoredBundle[],
): ChainabuseRequest {
  if (view.status !== "escalated")
    throw new NothingToReport(`it is ${view.status}, not escalated`);
  const addresses: ChainabuseAddress[] = [
    ...(view.domain === null
      ? []
      : [{ domain: view.domain, label: "Domain of the reported QR link" }]),
    ...view.recipients.map((address) => ({
      chain: "SOL" as const,
      address,
      // The reporter's claim: the API checks only that each is a public key, not that the
      // transaction pays it.
      label: "Recipient as reported to limen",
    })),
  ];
  if (addresses.length === 0)
    throw new NothingToReport("it has no domain or recipient to report");

  const shown = summaryBundle(bundles);
  // The summary as the body shows it, with every unlisted address left out.
  const kept =
    shown === undefined
      ? undefined
      : redactSummary(
          JSON.parse(shown.summaryJson),
          new Set([...view.recipients, ...view.programIds]),
        );
  const reproduced =
    shown?.resimulation?.matches === true && shown.resimulation.drainPattern;
  const yesNo = (b: boolean) => (b ? "yes" : "no");
  // The drain pattern comes from the decoded instructions, or from a simulation that ran without
  // an error. The stored record says only that it fired, so the opening names the decoded
  // instructions alone when the reproduced report's simulation did not run cleanly, and both
  // otherwise.
  const fromDecodedOnly =
    shown !== undefined &&
    simulationOutcome(JSON.parse(shown.summaryJson)) === "not clean";
  const devices = view.inputs.independentDevices;
  const description = [
    "### limen escalation: drain pattern",
    "",
    fromDecodedOnly
      ? "A QR reported through limen leads to a transaction whose decoded instructions hand over control of the signer's wallet or its token accounts. Its simulation did not run without an error, so no simulated movement of funds is claimed. limen simulates on Solana devnet only."
      : "A QR reported through limen leads to a transaction with a drain pattern: its decoded instructions, or a simulation that ran without an error, show control of the signer's wallet or its token accounts handed over, or the wallet swept. limen simulates on Solana devnet only.",
    "",
    `- Case: ${view.id}`,
    // Install IDs are what clients report about themselves, and the domain lists are the bundled
    // fixture lists until the owner rules on DECIDE 2, so the lines say no more than that.
    `- Decided by: ${view.decidedBy === "human" ? "human review" : "the automatic threshold (drain pattern, and two or more distinct reported install IDs or a domain on the bundled fixture list)"}`,
    `- Sightings: ${view.sightings}, from ${devices} distinct reported install ${devices === 1 ? "ID" : "IDs"}`,
    `- Domain: ${view.domain === null ? "none" : escapeMarkdown(view.domain)}`,
    `- Domain on the bundled fixture list: ${yesNo(view.inputs.domainListed)}`,
    `- Re-simulation reproduced the reported summary with a drain pattern: ${yesNo(reproduced)}`,
    ...(kept === undefined || kept.leftOut === 0
      ? []
      : [
          `- Summary values left out, so that no address beyond the recipients and programs below is reported: ${kept.leftOut}`,
        ]),
    "",
    "#### Simulated transaction summary",
    ...(kept === undefined
      ? ["- none stored"]
      : kept.summary === undefined
        ? ["- none"]
        : summaryLines(kept.summary)),
    "",
    "#### Programs",
    ...(view.programIds.length === 0
      ? ["- none"]
      : view.programIds.map((p) => `- ${p}`)),
    "",
    "#### Recipients as reported to limen",
    ...(view.recipients.length === 0
      ? ["- none"]
      : view.recipients.map((r) => `- ${r}`)),
  ].join("\n");

  const evidences =
    kept === undefined || kept.summary === undefined
      ? []
      : [
          {
            source: `limen simulated transaction summary (Solana devnet): ${canonicalJson(kept.summary)}`,
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
 * nothing. Dry run: logs the request line and the exact JSON body that would be sent, at most
 * once per case. When it builds nothing, it logs one line saying why, so no escalation passes
 * without a line in the log.
 */
export function chainabuseHook(
  mode: ChainabuseMode,
  db: DatabaseSync,
  lists: DomainLists,
  log: (line: string) => void,
): ((caseId: number) => void) | undefined {
  if (mode === "off") return undefined;
  // The cases whose request has been logged since the service started. Held in memory, so a
  // restart forgets them; a live mode would need them stored.
  const reported = new Set<number>();
  return (caseId) => {
    const skip = (reason: string) =>
      log(`chainabuse dry run, nothing built for case ${caseId}: ${reason}`);
    if (reported.has(caseId)) {
      skip("its request was already logged once since the service started");
      return;
    }
    let request: ChainabuseRequest;
    try {
      const view = loadCase(db, caseId, lists);
      if (view === null) {
        skip("there is no such case");
        return;
      }
      const ids = db
        .prepare("SELECT id FROM sightings WHERE case_id = ? ORDER BY id")
        .all(caseId) as { id: number }[];
      const bundles = ids
        .map((r) => loadBundle(db, r.id))
        .filter((b): b is StoredBundle => b !== null);
      request = buildChainabuseRequest(view, bundles);
    } catch (err) {
      // A refusal gives its reason. Any other failure is logged without its message, which
      // could quote report data (a JSON parse error quotes the text it read).
      skip(
        err instanceof NothingToReport
          ? err.message
          : "the request could not be built",
      );
      return;
    }
    reported.add(caseId);
    log(
      `chainabuse dry run, not sent: ${request.method} ${request.url}\n${JSON.stringify(request.body)}`,
    );
  };
}
