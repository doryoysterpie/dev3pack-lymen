// POST /checkins (E-05, app half). Sends the check-in to the backend and turns each answer into
// a sentence for the participant. Pure module: the fetch function is passed in.

import { encodeBase64 } from "./base64.ts";
import { appFetch, type HttpFetch } from "./http.ts";

export interface CheckinRequest {
  readonly qr: string;
  readonly wallet: string;
  readonly registrationId: string | null;
  readonly signature: Uint8Array;
}

export type CheckinResult =
  | {
      readonly ok: true;
      readonly station: string;
      readonly session: string;
      readonly mint: string;
      /**
       * The mint transaction's signature, or null when the backend found the pass already held
       * by the wallet at its mint address and sent nothing (E-05: a retry after a lost answer).
       */
      readonly signature: string | null;
    }
  | { readonly ok: false; readonly error: string; readonly message: string };

/** What the participant reads for each refusal the backend can give. */
export const CHECKIN_MESSAGES: Readonly<Record<string, string>> = {
  already_checked_in: "You have already checked in to this session.",
  pass_revoked: "The pass for this check-in was revoked.",
  station_qr_expired: "This station QR has expired. Scan the screen again.",
  station_qr_invalid: "This station QR did not pass the check.",
  unknown_station: "The server does not know this station.",
  session_closed: "This session is closed.",
  bad_wallet_signature: "The wallet's signature did not match. Try again.",
  invalid_registration_id:
    "A registration ID uses only letters, digits, hyphens and underscores.",
  unknown_registration: "That registration ID is not on the list.",
  registration_bound_to_other_wallet:
    "That registration ID is already linked to another wallet.",
  wallet_bound_to_other_registration:
    "This wallet is already linked to another registration ID.",
  no_registration_binding:
    "This wallet has no registration yet. Enter your registration ID.",
  // The outcome of a mint_failed is uncertain: the pass may have landed. A retry reads the chain
  // at the check-in's one mint address and finishes it (services/api/README.md, Minting).
  mint_failed:
    "The pass may already be in your wallet. Try again to finish the check-in.",
  check_in_unavailable: "Check-in is not available on this server yet.",
  invalid_request: "The server refused the request the app sent.",
  unreachable: "The check-in server cannot be reached.",
};

const refused = (error: string, status?: number): CheckinResult => ({
  ok: false,
  error,
  message: Object.hasOwn(CHECKIN_MESSAGES, error)
    ? (CHECKIN_MESSAGES[error] as string)
    : `The server answered with status ${status ?? "unknown"}.`,
});

/** The JSON body the backend reads. */
export function checkinBody(req: CheckinRequest): string {
  return JSON.stringify({
    qr: req.qr,
    wallet: req.wallet,
    registration_id: req.registrationId,
    signature: encodeBase64(req.signature),
  });
}

/** Posts one check-in to `<apiBase>/checkins` and reads the answer. Never throws. */
export async function postCheckin(
  fetchFn: HttpFetch,
  apiBase: string,
  req: CheckinRequest,
): Promise<CheckinResult> {
  let res: Response;
  try {
    res = await appFetch(
      `${apiBase.replace(/\/+$/, "")}/checkins`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: checkinBody(req),
      },
      fetchFn,
    );
  } catch {
    return refused("unreachable");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (res.status === 201 && b.status === "checked_in") {
    if (
      [b.station, b.session, b.mint].every((v) => typeof v === "string") &&
      (typeof b.signature === "string" || b.signature === null)
    ) {
      return {
        ok: true,
        station: b.station as string,
        session: b.session as string,
        mint: b.mint as string,
        signature: b.signature,
      };
    }
  }
  return refused(
    typeof b.error === "string" ? b.error : `status_${res.status}`,
    res.status,
  );
}
