// The check-in message the wallet signs (E-05, app half). It must match, byte for byte, the
// text the backend rebuilds to verify the signature (services/api/src/checkin.ts on E-05-held):
//
//   limen check-in v2
//   station: <station>
//   session: <session>
//   nonce: <nonce>
//   wallet: <wallet address>
//
// five lines joined by "\n", no trailing newline. The registration ID is not in it: it travels
// only in the POST body, so neither the wallet nor MWA's bridge is handed it. Every part is
// ASCII, so the bytes are the character codes. Pure module.

import { asciiBytes } from "./station-qr.ts";

const REGISTRATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A registration ID as the participant typed it, with surrounding space removed. Null unless it
 * is 1 to 64 ASCII letters, digits, "_" or "-", the only IDs the backend accepts (E-07).
 */
export function registrationIdInput(text: string): string | null {
  const id = text.trim();
  return REGISTRATION_ID.test(id) ? id : null;
}

export interface CheckinMessageParts {
  readonly station: string;
  readonly session: string;
  readonly nonce: string;
  readonly wallet: string;
}

export function checkinMessage(p: CheckinMessageParts): string {
  return [
    "limen check-in v2",
    `station: ${p.station}`,
    `session: ${p.session}`,
    `nonce: ${p.nonce}`,
    `wallet: ${p.wallet}`,
  ].join("\n");
}

/** The bytes the wallet signs. Null if any part is not ASCII or holds a line break. */
export function checkinMessageBytes(p: CheckinMessageParts): Uint8Array | null {
  const parts = [p.station, p.session, p.nonce, p.wallet];
  if (parts.some((part) => /[\r\n]/.test(part))) return null;
  return asciiBytes(checkinMessage(p));
}
