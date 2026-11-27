// Triage (E-11): groups sightings into cases by a dedup hash, counts sightings and devices,
// reads the bundled domain lists, applies the D-05 threshold and keeps the hold queue.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, loadBundle } from "./evidence.ts";

export type CaseStatus = "held" | "escalated" | "dismissed";
export type DecidedBy = "threshold" | "human";

/** The domain lists the threshold reads. Hostnames, lower case. */
export interface DomainLists {
  readonly phantom: ReadonlySet<string>;
  readonly phishdestroy: ReadonlySet<string>;
}

/** The bundled lists: fixture lists, not snapshots of the real ones (see fixtures/lists). */
export const BUNDLED_LISTS_URL = new URL(
  "../../../fixtures/lists/domain-lists.json",
  import.meta.url,
);

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

function hostnameSet(value: unknown, field: string): ReadonlySet<string> {
  if (
    !Array.isArray(value) ||
    !value.every((d) => typeof d === "string" && HOSTNAME.test(d))
  ) {
    throw new Error(
      `domain lists: ${field} must be an array of lower-case hostnames`,
    );
  }
  return new Set(value as string[]);
}

/** Reads { "phantom": [...], "phishdestroy": [...] }. Throws on a missing or malformed list. */
export function parseDomainLists(json: unknown): DomainLists {
  if (typeof json !== "object" || json === null) {
    throw new Error("domain lists: expected an object");
  }
  const record = json as Record<string, unknown>;
  return {
    phantom: hostnameSet(record.phantom, "phantom"),
    phishdestroy: hostnameSet(record.phishdestroy, "phishdestroy"),
  };
}

let bundled: DomainLists | undefined;

/** The bundled fixture lists, read once. */
export function bundledLists(): DomainLists {
  bundled ??= parseDomainLists(
    JSON.parse(readFileSync(BUNDLED_LISTS_URL, "utf8")),
  );
  return bundled;
}

/** True when the domain appears on either list, by exact hostname. */
export function domainListed(
  domain: string | null,
  lists: DomainLists,
): boolean {
  if (domain === null) return false;
  const host = domain.toLowerCase();
  return lists.phantom.has(host) || lists.phishdestroy.has(host);
}

/** What a case is keyed on: the domain, the program set and the recipient set. */
export interface CaseKey {
  readonly domain: string | null;
  readonly programIds: readonly string[];
  readonly recipients: readonly string[];
}

/** The hostname of a bundle URL in lower case, or null when the bundle has no URL. */
export function domainOf(url: string | null): string | null {
  return url === null ? null : new URL(url).hostname.toLowerCase();
}

/**
 * The dedup hash: SHA-256 over canonical JSON of a version tag, the domain, and the sorted,
 * deduplicated program and recipient sets. Two bundles with equal keys land in one case,
 * whatever their transaction bytes, devices or wallets.
 */
export function dedupHash(key: CaseKey): string {
  const sorted = (list: readonly string[]): string[] =>
    [...new Set(list)].sort();
  const text = canonicalJson([
    "limen:case:v1",
    key.domain,
    sorted(key.programIds),
    sorted(key.recipients),
  ]);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The D-05 inputs for one case. */
export interface ThresholdInputs {
  /** A re-simulation reproduced a stored summary in this case, and that summary shows a drain pattern. */
  readonly drainPattern: boolean;
  /** Distinct device hashes among the case's sightings. */
  readonly independentDevices: number;
  /** The case's domain is on the Phantom or PhishDestroy list. */
  readonly domainListed: boolean;
}

/**
 * D-05, as ruled on 2026-11-27: a case escalates automatically only when the simulation shows a
 * drain pattern AND (two or more independent devices reported it OR the domain already appears
 * on the Phantom or PhishDestroy lists). Everything else holds for a human.
 */
export function autoEscalates(inputs: ThresholdInputs): boolean {
  return (
    inputs.drainPattern &&
    (inputs.independentDevices >= 2 || inputs.domainListed)
  );
}

interface CaseRow {
  id: number;
  dedup_hash: string;
  domain: string | null;
  program_ids_json: string;
  recipients_json: string;
  status: CaseStatus;
  decided_by: DecidedBy | null;
  created_at: number;
  updated_at: number;
}

/** A case as the hold queue and the dashboard show it. */
export interface CaseView {
  readonly id: number;
  readonly status: CaseStatus;
  readonly decidedBy: DecidedBy | null;
  readonly domain: string | null;
  readonly programIds: readonly string[];
  readonly recipients: readonly string[];
  readonly sightings: number;
  readonly inputs: ThresholdInputs;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Reads the D-05 inputs for a case from its sightings and bundles. */
export function thresholdInputs(
  db: DatabaseSync,
  caseId: number,
  domain: string | null,
  lists: DomainLists,
): ThresholdInputs {
  const row = db
    .prepare(
      `SELECT count(DISTINCT s.device_hash) AS devices,
              coalesce(max(b.resimulation_matches = 1 AND b.drain_pattern = 1), 0) AS drain
       FROM sightings s LEFT JOIN evidence_bundles b ON b.sighting_id = s.id
       WHERE s.case_id = ?`,
    )
    .get(caseId) as { devices: number; drain: number };
  return {
    drainPattern: row.drain === 1,
    independentDevices: row.devices,
    domainListed: domainListed(domain, lists),
  };
}

function caseView(
  db: DatabaseSync,
  row: CaseRow,
  lists: DomainLists,
): CaseView {
  const { n } = db
    .prepare("SELECT count(*) AS n FROM sightings WHERE case_id = ?")
    .get(row.id) as { n: number };
  return {
    id: row.id,
    status: row.status,
    decidedBy: row.decided_by,
    domain: row.domain,
    programIds: JSON.parse(row.program_ids_json) as string[],
    recipients: JSON.parse(row.recipients_json) as string[],
    sightings: n,
    inputs: thresholdInputs(db, row.id, row.domain, lists),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Loads one case, or null when there is none. */
export function loadCase(
  db: DatabaseSync,
  caseId: number,
  lists: DomainLists,
): CaseView | null {
  const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId) as
    CaseRow | undefined;
  return row === undefined ? null : caseView(db, row, lists);
}

export interface TriageOutcome {
  readonly case: CaseView;
  readonly createdCase: boolean;
  /** True when this sighting moved the case from held to escalated. */
  readonly escalatedNow: boolean;
}

/**
 * Puts a stored sighting into the case its bundle keys to, creating the case as held when it is
 * new, then applies the D-05 threshold. Only a held case can escalate here: an escalated case
 * stays escalated and a dismissed case stays dismissed, whatever sightings arrive.
 */
export function triageSighting(
  db: DatabaseSync,
  sightingId: number,
  lists: DomainLists,
  now: number,
): TriageOutcome {
  const bundle = loadBundle(db, sightingId);
  if (bundle === null)
    throw new Error(`sighting ${sightingId} has no evidence bundle`);
  const key: CaseKey = {
    domain: domainOf(bundle.url),
    programIds: bundle.programIds,
    recipients: bundle.recipients,
  };
  const hash = dedupHash(key);

  db.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db
      .prepare(
        `INSERT INTO cases (dedup_hash, domain, program_ids_json, recipients_json, status,
           decided_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'held', NULL, ?, ?)
         ON CONFLICT (dedup_hash) DO NOTHING`,
      )
      .run(
        hash,
        key.domain,
        JSON.stringify(key.programIds),
        JSON.stringify(key.recipients),
        now,
        now,
      );
    const row = db
      .prepare("SELECT * FROM cases WHERE dedup_hash = ?")
      .get(hash) as unknown as CaseRow;
    db.prepare("UPDATE sightings SET case_id = ? WHERE id = ?").run(
      row.id,
      sightingId,
    );

    const inputs = thresholdInputs(db, row.id, row.domain, lists);
    const escalatedNow = row.status === "held" && autoEscalates(inputs);
    if (escalatedNow) {
      db.prepare(
        "UPDATE cases SET status = 'escalated', decided_by = 'threshold', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
    } else {
      db.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").run(
        now,
        row.id,
      );
    }
    const view = loadCase(db, row.id, lists);
    db.exec("COMMIT");
    if (view === null) throw new Error(`case ${row.id} vanished`);
    return { case: view, createdCase: inserted.changes === 1, escalatedNow };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The hold queue: every held case, most recently updated first. */
export function holdQueue(db: DatabaseSync, lists: DomainLists): CaseView[] {
  const rows = db
    .prepare(
      "SELECT * FROM cases WHERE status = 'held' ORDER BY updated_at DESC, id DESC",
    )
    .all() as unknown as CaseRow[];
  return rows.map((row) => caseView(db, row, lists));
}
