// The check-in flow (E-05, app half), in two steps the panel shows one at a time.
//
//   prepareCheckin: verify the station QR on the device, check the registration ID, connect the
//   wallet (authorize, which signs nothing), and build the check-in message for its account. It
//   returns the message's six lines for the panel to show, and a sign() for the panel's separate
//   "Sign this message" action.
//
//   sign(): check the QR is still in its window, have the wallet sign exactly the bytes shown,
//   and post the check-in.
//
// The wallet and Ed25519 come in as functions, so this module stays pure; the Mobile Wallet
// Adapter signer plugs in as a WalletSigner.

import { CHECKIN_MESSAGES, postCheckin, type CheckinResult } from "./client.ts";
import { checkinMessageBytes, registrationIdInput } from "./message.ts";
import { verifyStationQrOnDevice, type Ed25519Verify } from "./station-qr.ts";

/** The wallet account a check-in is signed as. */
export interface WalletAccount {
  /** The account's base58 address, which the backend takes. */
  readonly wallet: string;
  /** Its 32-byte Ed25519 public key. */
  readonly key: Uint8Array;
  /** The address as the wallet named it (base64 from MWA), for asking it to sign. */
  readonly address: string;
  /** The wallet's authorization token, so the signing session can authorize as this account again. */
  readonly authToken: string;
}

export interface WalletSigner {
  /** Connects to the wallet and returns its account. It asks the wallet to sign nothing. */
  connect(): Promise<WalletAccount>;
  /** Has the wallet sign exactly `message` as `account`, and returns the 64-byte signature. */
  sign(account: WalletAccount, message: Uint8Array): Promise<Uint8Array>;
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

/** The message a check-in will sign, as the panel shows it before anything is signed. */
export interface CheckinPreview {
  /** The six lines of the message; joined by "\n", they are exactly `bytes`. */
  readonly lines: readonly string[];
  /** The bytes the wallet will be asked to sign. */
  readonly bytes: Uint8Array;
}

export type CheckinRefusal = Extract<CheckinResult, { ok: false }>;

export type PreparedCheckin =
  | {
      readonly ok: true;
      readonly preview: CheckinPreview;
      /** Signs exactly `preview.bytes` and posts the check-in. */
      readonly sign: () => Promise<CheckinResult>;
    }
  | CheckinRefusal;

export const FLOW_MESSAGES = {
  no_server:
    "This build has no check-in server. Set EXPO_PUBLIC_API_URL when building the app.",
  wallet_not_connected:
    "The wallet did not connect. Nothing was signed or sent.",
  wallet_declined:
    "The wallet did not sign, or its signature did not verify on this device. Nothing was sent.",
  no_message: "There is no check-in message to sign for this account.",
  qr_unchecked:
    "The app could not check this station QR's signature. Nothing was sent.",
} as const;

const refuse = (error: string, message: string): CheckinRefusal => ({
  ok: false,
  error,
  message,
});

/** The station QR's verdict now, as the refusal the participant reads, or its payload. */
function checkQr(deps: CheckinFlowDeps, qr: string) {
  const result = verifyStationQrOnDevice(qr, {
    allowlist: deps.allowlist,
    nowMs: deps.nowMs(),
    verify: deps.verify,
  });
  if (result.ok) return result;
  // The check could not run: that is no finding about the QR.
  if (result.reason === "verify_failed")
    return refuse("station_qr_unchecked", FLOW_MESSAGES.qr_unchecked);
  const error =
    result.reason === "expired" ? "station_qr_expired" : "station_qr_invalid";
  return refuse(error, CHECKIN_MESSAGES[error] as string);
}

/**
 * Prepares one check-in. Nothing reaches the wallet unless the QR verifies on the device and the
 * registration ID is well formed; the wallet is then only connected, and nothing is signed or
 * sent until the returned sign() runs.
 */
export async function prepareCheckin(
  deps: CheckinFlowDeps,
  input: { readonly qr: string; readonly registrationText: string },
): Promise<PreparedCheckin> {
  if (deps.apiBase === null)
    return refuse("no_server", FLOW_MESSAGES.no_server);
  const apiBase = deps.apiBase;

  const qr = checkQr(deps, input.qr);
  if (!qr.ok) return qr;

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

  let account: WalletAccount;
  try {
    account = await deps.signer.connect();
  } catch {
    return refuse("wallet_not_connected", FLOW_MESSAGES.wallet_not_connected);
  }
  const bytes = checkinMessageBytes({
    ...qr.payload,
    wallet: account.wallet,
    registrationId,
  });
  if (bytes === null) return refuse("no_message", FLOW_MESSAGES.no_message);
  // The message is ASCII, so each byte is one character of the text shown.
  const lines = String.fromCharCode(...bytes).split("\n");

  return {
    ok: true,
    preview: { lines, bytes },
    sign: async () => {
      // The QR may have run out of time while the message was on screen.
      const still = checkQr(deps, input.qr);
      if (!still.ok) return still;
      let signature: Uint8Array;
      try {
        signature = await deps.signer.sign(account, bytes);
      } catch {
        return refuse("wallet_declined", FLOW_MESSAGES.wallet_declined);
      }
      return postCheckin(deps.fetchFn, apiBase, {
        qr: input.qr,
        wallet: account.wallet,
        registrationId,
        signature,
      });
    },
  };
}
