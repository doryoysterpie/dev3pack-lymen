// Standard base64 (RFC 4648, section 4) with padding. Pure module: React
// Native has no Buffer, so the app cannot lean on Node's.

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const VALUE = new Map<string, number>(
  Array.from(ALPHABET, (character, index) => [character, index]),
);

/**
 * Decodes padded standard base64. Returns null for any other text: a length
 * that is not a multiple of 4, a character outside the alphabet, or padding
 * anywhere but the end.
 */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const body = text.length - padding;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);

  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    let chunk = 0;
    for (let j = 0; j < 4; j += 1) {
      const position = i + j;
      let value = 0;
      if (position < body) {
        const found = VALUE.get(text[position]);
        if (found === undefined) return null;
        value = found;
      }
      chunk = chunk * 64 + value;
    }
    const triple = [(chunk >> 16) & 0xff, (chunk >> 8) & 0xff, chunk & 0xff];
    for (const byte of triple) {
      if (out < bytes.length) {
        bytes[out] = byte;
        out += 1;
      }
    }
  }
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const chunk = (a << 16) | (b << 8) | c;
    text += ALPHABET[(chunk >> 18) & 63] + ALPHABET[(chunk >> 12) & 63];
    text += i + 1 < bytes.length ? ALPHABET[(chunk >> 6) & 63] : "=";
    text += i + 2 < bytes.length ? ALPHABET[chunk & 63] : "=";
  }
  return text;
}
