// Evidence bundles (E-10): checking a report from the app, storing it as a sighting with its
// bundle, and re-simulating the stored transaction bytes.
//
// A report carries the QR payload, the URL behind it, the transaction bytes, the slot and
// blockhash of the app's simulation, the decoded summary the app showed, the program IDs and
// recipients, the app's timestamp and version, and an install-scoped device ID. The user's
// wallet is left out unless the report sets include_wallet to true. The stored transaction
// bytes still name the signing wallet as an account key, because re-simulation needs them whole.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { isPublicKey } from "./base58.ts";

/** Solana's maximum transaction size in bytes (the packet data size). */
export const MAX_TRANSACTION_BYTES = 1232;
const MAX_PAYLOAD_CHARS = 4096;
const MAX_URL_CHARS = 2048;
const MAX_SUMMARY_CHARS = 16384;
const MAX_ADDRESSES = 64;
/** How far ahead of the server's clock a report's timestamp may be, for phone clock drift. */
export const MAX_CLOCK_AHEAD_S = 300;
/** The last whole second a JavaScript Date can hold (8.64e15 ms). */
export const MAX_DATE_SECONDS = 8_640_000_000_000;

const REPORT_FIELDS = new Set([
  "device_id",
  "payload",
  "url",
  "transaction",
  "simulation",
  "summary",
  "program_ids",
  "recipients",
  "timestamp",
  "app_version",
  "wallet",
  "include_wallet",
]);

/** A report that passed every check, in the form it is stored. */
export interface Report {
  readonly deviceHash: string;
  readonly payload: string;
  readonly url: string | null;
  readonly transaction: Uint8Array | null;
  readonly simulation: {
    readonly slot: number;
    readonly blockhash: string;
  } | null;
  /** Canonical JSON of the decoded summary. */
  readonly summaryJson: string;
  /** Sorted and deduplicated. */
  readonly programIds: readonly string[];
  /** Sorted and deduplicated. */
  readonly recipients: readonly string[];
  readonly reportedAt: number;
  readonly appVersion: string;
  /** Null unless the report opted in with include_wallet. */
  readonly wallet: string | null;
}

/** A stored sighting with its bundle. */
export interface StoredBundle extends Report {
  readonly sightingId: number;
  readonly receivedAt: number;
  /** When the latest re-simulation was tried and failed; null once one succeeds. */
  readonly resimulationFailedAt: number | null;
  readonly resimulation: {
    readonly at: number;
    readonly matches: boolean;
    readonly drainPattern: boolean;
  } | null;
}

export type ParseResult =
  | { readonly ok: true; readonly report: Report }
  | { readonly ok: false; readonly field: string };

/**
 * JSON with object keys sorted at every depth, so two equal summaries give equal text.
 * Throws a TypeError on anything JSON cannot hold (bigint, undefined, a non-finite number).
 */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      );
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`${typeof value} is not JSON`);
}

/**
 * The part of a summary a re-simulation must reproduce for the bundle to match (owner ruling 7a):
 * the decoded instructions. For the pre-flight report shape
 * { kind, feePayerSet, summary, simulation, blocks } this keeps `kind` and `summary` only. It
 * drops `simulation`, whose balance changes drift as account state moves; `blocks`, whose
 * simulation-not-run and simulation-failed come from the simulation's outcome; and
 * `feePayerSet`, which the app's report sets when limen rebuilt the request with the wallet as
 * fee payer, while a replay of the stored, rebuilt bytes finds the fee payer already set. A
 * report with no `summary`, such as a refusal, compares on its kind alone.
 */
export function decodedPart(summary: unknown): unknown {
  if (
    typeof summary !== "object" ||
    summary === null ||
    Array.isArray(summary)
  ) {
    return summary;
  }
  const kept: Record<string, unknown> = {};
  for (const key of ["kind", "summary"]) {
    if (Object.hasOwn(summary, key)) {
      kept[key] = (summary as Record<string, unknown>)[key];
    }
  }
  return kept;
}

/** The stored device hash: SHA-256 of a fixed prefix and the app's install-scoped device ID. */
export function deviceHash(deviceId: string): string {
  return createHash("sha256")
    .update(`limen:device:v1:${deviceId}`, "utf8")
    .digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnixSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function addressList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ADDRESSES) return null;
  if (!value.every((a) => typeof a === "string" && isPublicKey(a))) return null;
  return [...new Set(value as string[])].sort();
}

function httpUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_URL_CHARS)
    return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function transactionBytes(value: unknown): Uint8Array | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const bytes = Buffer.from(value, "base64");
  // Only canonical, padded base64 is accepted, so the stored text names exactly these bytes.
  if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES)
    return undefined;
  if (bytes.toString("base64") !== value) return undefined;
  return new Uint8Array(bytes);
}

/**
 * Checks a parsed JSON report body against the server's clock `now` (Unix seconds). On failure,
 * names the first field that failed.
 */
export function parseReport(body: unknown, now: number): ParseResult {
  const fail = (field: string): ParseResult => ({ ok: false, field });
  if (!isPlainObject(body)) return fail("body");
  for (const key of Object.keys(body))
    if (!REPORT_FIELDS.has(key)) return fail(key);

  const { device_id, payload, simulation, summary, timestamp, app_version } =
    body;
  if (
    typeof device_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(device_id)
  ) {
    return fail("device_id");
  }
  if (
    typeof payload !== "string" ||
    payload.length === 0 ||
    payload.length > MAX_PAYLOAD_CHARS
  ) {
    return fail("payload");
  }
  const url = httpUrl(body.url ?? null);
  if (url === undefined) return fail("url");
  const transaction = transactionBytes(body.transaction ?? null);
  if (transaction === undefined) return fail("transaction");

  let sim: Report["simulation"] = null;
  if (simulation !== undefined && simulation !== null) {
    if (
      transaction === null ||
      !isPlainObject(simulation) ||
      Object.keys(simulation).sort().join() !== "blockhash,slot" ||
      !Number.isSafeInteger(simulation.slot) ||
      (simulation.slot as number) < 0 ||
      typeof simulation.blockhash !== "string" ||
      !isPublicKey(simulation.blockhash)
    ) {
      return fail("simulation");
    }
    sim = { slot: simulation.slot as number, blockhash: simulation.blockhash };
  }

  if (!isPlainObject(summary)) return fail("summary");
  let summaryJson: string;
  try {
    summaryJson = canonicalJson(summary);
  } catch {
    return fail("summary");
  }
  if (summaryJson.length > MAX_SUMMARY_CHARS) return fail("summary");

  const programIds = addressList(body.program_ids);
  if (programIds === null) return fail("program_ids");
  const recipients = addressList(body.recipients);
  if (recipients === null) return fail("recipients");
  if (
    !isUnixSeconds(timestamp) ||
    timestamp > now + MAX_CLOCK_AHEAD_S ||
    timestamp > MAX_DATE_SECONDS
  ) {
    return fail("timestamp");
  }
  if (
    typeof app_version !== "string" ||
    !/^[0-9A-Za-z.+-]{1,32}$/.test(app_version)
  ) {
    return fail("app_version");
  }

  const includeWallet = body.include_wallet ?? false;
  if (typeof includeWallet !== "boolean") return fail("include_wallet");
  let wallet: string | null = null;
  if (includeWallet) {
    if (typeof body.wallet !== "string" || !isPublicKey(body.wallet))
      return fail("wallet");
    wallet = body.wallet;
  } else if (body.wallet !== undefined && body.wallet !== null) {
    // Excluded by default: a wallet sent without the opt-in is dropped, not stored.
    if (typeof body.wallet !== "string") return fail("wallet");
  }

  return {
    ok: true,
    report: {
      deviceHash: deviceHash(device_id),
      payload,
      url,
      transaction,
      simulation: sim,
      summaryJson,
      programIds,
      recipients,
      reportedAt: timestamp,
      appVersion: app_version,
      wallet,
    },
  };
}

/** Stores a report as a sighting with no case yet, and its bundle. Returns the sighting ID. */
export function storeReport(
  db: DatabaseSync,
  report: Report,
  now: number,
): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO sightings (device_hash, qr_text, created_at) VALUES (?, ?, ?)",
      )
      .run(report.deviceHash, report.payload, now);
    const sightingId = Number(lastInsertRowid);
    db.prepare(
      `INSERT INTO evidence_bundles (sighting_id, url, transaction_b64, simulation_slot,
         simulation_blockhash, summary_json, program_ids_json, recipients_json, reported_at,
         app_version, wallet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sightingId,
      report.url,
      report.transaction === null
        ? null
        : Buffer.from(report.transaction).toString("base64"),
      report.simulation?.slot ?? null,
      report.simulation?.blockhash ?? null,
      report.summaryJson,
      JSON.stringify(report.programIds),
      JSON.stringify(report.recipients),
      report.reportedAt,
      report.appVersion,
      report.wallet,
    );
    db.exec("COMMIT");
    return sightingId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

interface BundleRow {
  sighting_id: number;
  device_hash: string;
  qr_text: string;
  created_at: number;
  url: string | null;
  transaction_b64: string | null;
  simulation_slot: number | null;
  simulation_blockhash: string | null;
  summary_json: string;
  program_ids_json: string;
  recipients_json: string;
  reported_at: number;
  app_version: string;
  wallet: string | null;
  resimulated_at: number | null;
  resimulation_matches: number | null;
  drain_pattern: number | null;
  resimulation_failed_at: number | null;
}

/** Loads a stored sighting and its bundle, or null when there is none. */
export function loadBundle(
  db: DatabaseSync,
  sightingId: number,
): StoredBundle | null {
  const row = db
    .prepare(
      `SELECT s.id AS sighting_id, s.device_hash, s.qr_text, s.created_at, b.*
       FROM sightings s JOIN evidence_bundles b ON b.sighting_id = s.id
       WHERE s.id = ?`,
    )
    .get(sightingId) as BundleRow | undefined;
  if (row === undefined) return null;
  return {
    sightingId: row.sighting_id,
    receivedAt: row.created_at,
    deviceHash: row.device_hash,
    payload: row.qr_text,
    url: row.url,
    transaction:
      row.transaction_b64 === null
        ? null
        : new Uint8Array(Buffer.from(row.transaction_b64, "base64")),
    simulation:
      row.simulation_slot === null || row.simulation_blockhash === null
        ? null
        : { slot: row.simulation_slot, blockhash: row.simulation_blockhash },
    summaryJson: row.summary_json,
    programIds: JSON.parse(row.program_ids_json) as string[],
    recipients: JSON.parse(row.recipients_json) as string[],
    reportedAt: row.reported_at,
    appVersion: row.app_version,
    wallet: row.wallet,
    resimulationFailedAt: row.resimulation_failed_at,
    resimulation:
      row.resimulated_at === null
        ? null
        : {
            at: row.resimulated_at,
            matches: row.resimulation_matches === 1,
            drainPattern: row.drain_pattern === 1,
          },
  };
}

/**
 * What the server needs from the E-09 pre-flight package: simulate the transaction bytes on
 * devnet and decode the result into the summary the app shows, and say whether that summary
 * shows a drain pattern. Bound when the package lands; until then no re-simulation runs.
 */
export type Resimulator = (
  transaction: Uint8Array,
) => Promise<{ readonly summary: unknown; readonly drainPattern: boolean }>;

/**
 * How long a re-simulation may take before it counts as failed. The report is already stored,
 * so a re-simulator that never answers must not hold the client's request open until it retries
 * and files the report twice.
 */
export const RESIMULATION_TIMEOUT_MS = 15_000;

/** Rejects when `work` has not settled within `ms` milliseconds. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("re-simulation timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export type ResimulationResult =
  | { readonly status: "no_bundle" | "no_transaction" | "failed" }
  | {
      readonly status: "resimulated";
      readonly matches: boolean;
      readonly drainPattern: boolean;
      readonly summaryJson: string;
    };

/**
 * Re-simulates a stored bundle from its stored transaction bytes, compares the summary with
 * the stored one as canonical JSON, and records the outcome on the bundle.
 */
export async function resimulateBundle(
  db: DatabaseSync,
  sightingId: number,
  resimulate: Resimulator,
  now: number,
  timeoutMs: number = RESIMULATION_TIMEOUT_MS,
): Promise<ResimulationResult> {
  const bundle = loadBundle(db, sightingId);
  if (bundle === null) return { status: "no_bundle" };
  if (bundle.transaction === null) return { status: "no_transaction" };
  let result: Awaited<ReturnType<Resimulator>>;
  let summaryJson: string;
  try {
    result = await withTimeout(resimulate(bundle.transaction), timeoutMs);
    summaryJson = canonicalJson(result.summary);
  } catch {
    // An RPC outage or a summary JSON cannot hold. The report stays stored; the failure is
    // recorded, and any earlier outcome is left as it was.
    db.prepare(
      "UPDATE evidence_bundles SET resimulation_failed_at = ? WHERE sighting_id = ?",
    ).run(now, sightingId);
    return { status: "failed" };
  }
  const matches =
    canonicalJson(decodedPart(result.summary)) ===
    canonicalJson(decodedPart(JSON.parse(bundle.summaryJson)));
  db.prepare(
    `UPDATE evidence_bundles SET resimulated_at = ?, resimulation_matches = ?, drain_pattern = ?,
       resimulation_failed_at = NULL
     WHERE sighting_id = ?`,
  ).run(now, matches ? 1 : 0, result.drainPattern ? 1 : 0, sightingId);
  return {
    status: "resimulated",
    matches,
    drainPattern: result.drainPattern,
    summaryJson,
  };
}
