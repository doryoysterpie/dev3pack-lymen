// The evidence bundle the app sends with a report (E-10, app side). Pure module, so the
// bundle for a fixture drainer is tested in Node.
//
// The bundle follows the API's POST /reports format (services/api/src/evidence.ts on E-10):
// device_id, payload, url, transaction, simulation, summary, program_ids, recipients,
// timestamp and app_version, and wallet with include_wallet only when the reporter opts in.
// summary is toReport(preflight), where addresses are replaced by role markers;
// program_ids and recipients come from preflight's in-memory unmarked lists (bundleLists),
// never from report JSON. The transaction bytes still name the signing wallet as an account
// key: the server needs them whole to re-simulate.

import {
  toReport,
  type Preflight,
  type PreflightReport,
  type SimulatedAt,
} from "@limen/preflight";

export type ReadyPreflight = Extract<Preflight, { kind: "ready" }>;

export interface ReportSimulation {
  readonly slot: number;
  readonly blockhash: string;
}

export interface ReportBundle {
  readonly device_id: string;
  readonly payload: string;
  readonly url: string;
  readonly transaction: string;
  readonly simulation: ReportSimulation | null;
  readonly summary: PreflightReport;
  readonly program_ids: readonly string[];
  readonly recipients: readonly string[];
  readonly timestamp: number;
  readonly app_version: string;
  readonly include_wallet?: true;
  readonly wallet?: string;
}

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

function simulationOf(
  simulatedAt: SimulatedAt | null,
): ReportSimulation | null {
  if (
    simulatedAt === null ||
    simulatedAt.slot === null ||
    simulatedAt.blockhash === null
  ) {
    return null;
  }
  return { slot: simulatedAt.slot, blockhash: simulatedAt.blockhash };
}

export function buildReport(input: ReportInput): ReportBundle {
  const { preflight } = input;
  const bundle: ReportBundle = {
    device_id: input.deviceId,
    payload: input.qrText,
    url: input.link,
    transaction: preflight.base64,
    simulation: simulationOf(preflight.simulatedAt),
    summary: toReport(preflight),
    program_ids: preflight.programIds,
    recipients: preflight.recipients,
    timestamp: input.timestamp,
    app_version: input.appVersion,
  };
  return input.includeWallet
    ? { ...bundle, include_wallet: true, wallet: input.user }
    : bundle;
}
