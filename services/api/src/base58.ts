// Base58 (the Bitcoin alphabet Solana uses): decoding, for checking that an address in an evidence
// bundle is a 32-byte public key (E-10), and encoding, for naming a pass's mint address (E-05).
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const DIGIT: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((c, i) => [c, i]),
);

/** Decodes base58 text, or returns null when it holds a character outside the alphabet. */
export function decodeBase58(text: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const char of text) {
    const digit = DIGIT.get(char);
    if (digit === undefined) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" stands for one leading zero byte.
  for (const char of text) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** Encodes bytes as base58 text; each leading zero byte is written as a leading "1". */
export function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let text = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    text += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) text += ALPHABET[digits[i]];
  return text;
}

/** True when the text is the base58 form of exactly 32 bytes, as a Solana public key is. */
export function isPublicKey(text: string): boolean {
  if (text.length < 32 || text.length > 44) return false;
  const bytes = decodeBase58(text);
  return bytes !== null && bytes.length === 32;
}
