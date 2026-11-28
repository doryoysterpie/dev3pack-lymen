// Wallet addresses for the check-in flow (E-05, app half). Mobile Wallet Adapter names an account
// by its public key in standard base64; the backend (E-07) takes the base58 address Solana uses.
// Pure module.

import { decodeBase64Url } from "./base64.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 with the Bitcoin alphabet: each leading zero byte becomes a leading "1". */
export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}

/** Decodes canonical standard base64 (with padding), or returns null. */
export function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    return null;
  return decodeBase64Url(
    text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
  );
}

/** The base58 address of an MWA account, given its base64 public key; null unless 32 bytes. */
export function walletAddressFromMwa(base64Key: string): string | null {
  const key = decodeBase64(base64Key);
  return key !== null && key.length === 32 ? encodeBase58(key) : null;
}
