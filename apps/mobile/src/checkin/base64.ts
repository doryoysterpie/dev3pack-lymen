// Base64 for the check-in flow (E-05, app half). Pure module: no Buffer, which React Native
// lacks, so the Node tests run the code the app runs.

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    const left = bytes.length - i;
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += left > 1 ? alphabet[(n >> 6) & 63] : pad ? "=" : "";
    out += left > 2 ? alphabet[n & 63] : pad ? "=" : "";
  }
  return out;
}

/** Standard base64 with padding, as the check-in request carries the signature. */
export function encodeBase64(bytes: Uint8Array): string {
  return encode(bytes, ALPHABET, true);
}

/** Unpadded base64url, as the station QR carries its parts. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encode(bytes, URL_ALPHABET, false);
}

/**
 * Decodes unpadded base64url. Returns null for any other character, an impossible length, or a
 * spelling that is not the canonical one for its bytes, so each byte string has one spelling.
 */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const c of text) {
    value = (value << 6) | URL_ALPHABET.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return encodeBase64Url(out) === text ? out : null;
}
