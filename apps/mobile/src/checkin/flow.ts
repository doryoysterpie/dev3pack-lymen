// The check-in flow (E-05, app half): verify the station QR on the device, have the wallet sign
// the check-in message, and post it. The wallet and Ed25519 come in as functions, so this module
// stays pure; the Mobile Wallet Adapter signer plugs in as a WalletSigner.

import { CHECKIN_MESSAGES, postCheckin, type CheckinResult } from "./client.ts";
import { checkinMessageBytes, registrationIdInput } from "./message.ts";
import { verifyStationQrOnDevice, type Ed25519Verify } from "./station-qr.ts";

/** Connects to a wallet, builds the message for its address, and has the wallet sign it. */
export interface WalletSigner {
  signCheckin(
    build: (wallet: string) => Uint8Array | null,
  ): Promise<{ readonly wallet: string; readonly signature: Uint8Array }>;
}

export interface CheckinFlowDeps {
  /** The API base URL, or null when this build has none. */
  readonly apiBase: string | null;
  readonly allowlist: ReadonlySet<string>;
  /** The current Unix time in milliseconds (Date.now in the app). */
  readonly nowMs: () => number;
  readonly verify: Ed25519Verify;
  readonly signer: WalletSigner;
  readonly fetchFn: typeof fetch;
}

export const FLOW_MESSAGES = {
  no_server:
    "This build has no check-in server. Set EXPO_PUBLIC_API_URL when building the app.",
  wallet_declined:
    "The wallet did not sign, or its signature did not verify on this device. Nothing was sent.",
} as const;

const refuse = (error: string, message: string): CheckinResult => ({
  ok: false,
  error,
  message,
});

/**
 * Runs one check-in. Nothing reaches the wallet unless the QR verifies on the device and the
 * registration ID is well formed, and nothing reaches the server unless the wallet signs.
 */
export async function runCheckin(
  deps: CheckinFlowDeps,
  input: { readonly qr: string; readonly registrationText: string },
): Promise<CheckinResult> {
  if (deps.apiBase === null)
    return refuse("no_server", FLOW_MESSAGES.no_server);

  const qr = verifyStationQrOnDevice(input.qr, {
    allowlist: deps.allowlist,
    nowMs: deps.nowMs(),
    verify: deps.verify,
  });
  if (!qr.ok) {
    const error =
      qr.reason === "expired" ? "station_qr_expired" : "station_qr_invalid";
    return refuse(error, CHECKIN_MESSAGES[error] as string);
  }

  let registrationId: string | null = null;
  if (input.registrationText.trim() !== "") {
    registrationId = registrationIdInput(input.registrationText);
    if (registrationId === null) {
      return refuse(
        "invalid_registration_id",
        CHECKIN_MESSAGES.invalid_registration_id as string,
      );
    }
  }

  let signed: { wallet: string; signature: Uint8Array };
  try {
    signed = await deps.signer.signCheckin((wallet) =>
      checkinMessageBytes({ ...qr.payload, wallet, registrationId }),
    );
  } catch {
    return refuse("wallet_declined", FLOW_MESSAGES.wallet_declined);
  }

  return postCheckin(deps.fetchFn, deps.apiBase, {
    qr: input.qr,
    wallet: signed.wallet,
    registrationId,
    signature: signed.signature,
  });
}
