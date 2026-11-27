// Base58 decoding with the Bitcoin alphabet, which Solana uses for public keys.
// Pure module: no React Native or Node imports, so the done tests run in Node.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const DIGIT = new Map<string, number>(
  Array.from(ALPHABET, (character, index) => [character, index]),
);

// A 32-byte value never needs more than 44 base58 characters.
const MAX_PUBLIC_KEY_LENGTH = 44;

/**
 * Decodes base58 text to bytes. Returns null when the text holds a character
 * outside the alphabet. Each leading "1" decodes to one leading zero byte.
 */
export function decodeBase58(text: string): Uint8Array | null {
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === "1") {
    leadingZeros += 1;
  }

  // Base 256 digits of the value, least significant first.
  const digits: number[] = [];
  for (const character of text) {
    const value = DIGIT.get(character);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] * 58;
      digits[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const bytes = new Uint8Array(leadingZeros + digits.length);
  for (let i = 0; i < digits.length; i += 1) {
    bytes[bytes.length - 1 - i] = digits[i];
  }
  return bytes;
}

/**
 * Decodes the text as a Solana public key: base58 that decodes to exactly 32
 * bytes. Returns null otherwise. It does not check that the key is on the
 * Ed25519 curve, because program-derived addresses are off the curve.
 */
export function decodePublicKey(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > MAX_PUBLIC_KEY_LENGTH) return null;
  const bytes = decodeBase58(text);
  return bytes !== null && bytes.length === 32 ? bytes : null;
}
