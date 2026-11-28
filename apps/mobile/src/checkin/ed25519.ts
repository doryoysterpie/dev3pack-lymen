// Ed25519 verification on the device (E-05, app half), from @noble/curves, under the rules the
// backend applies to a wallet's check-in signature (walletSignatureValid in
// services/api/src/checkin.ts): the key and the signature's R must each be canonically encoded
// and in the prime-order subgroup, and then noble's RFC 8032 check, with ZIP-215 off, must pass.
// That check refuses an S at or above L itself, as speccheck vectors 6 and 7 show
// (ed25519.test.ts). The device checks the station QR's signature and the wallet's with it, so a
// wallet signature the backend would refuse is never sent.

import { ed25519 } from "@noble/curves/ed25519.js";

import type { Ed25519Verify } from "./station-qr.ts";

/**
 * True when `bytes` decodes, under RFC 8032's canonical rules (y below p, no sign bit on x = 0),
 * to a point of the prime-order subgroup other than the identity: no small or mixed order.
 */
function primeOrderPoint(bytes: Uint8Array): boolean {
  try {
    const point = ed25519.Point.fromBytes(bytes, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
}

export const ed25519Verify: Ed25519Verify = (publicKey, message, signature) => {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    return (
      primeOrderPoint(publicKey) &&
      primeOrderPoint(signature.subarray(0, 32)) &&
      ed25519.verify(signature, message, publicKey, { zip215: false })
    );
  } catch {
    return false;
  }
};
