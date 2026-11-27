// Ed25519 verification on the device (E-05, app half), from @noble/curves. Strict RFC 8032
// verification (zip215: false), the rule the backend's OpenSSL applies, so the device and the
// backend accept the same signatures.

import { ed25519 } from "@noble/curves/ed25519.js";

import type { Ed25519Verify } from "./station-qr.ts";

export const ed25519Verify: Ed25519Verify = (publicKey, message, signature) => {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
};
