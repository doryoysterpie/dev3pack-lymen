// Program-derived addresses (E-09; the owner's audit of 6c4e64e, Major 7),
// for the one address an associated token account creation can take. Pure
// module: SHA-256 and the Ed25519 point test in plain TypeScript, so it runs
// the same in Hermes and Node. src/pda.test.ts checks both against
// @solana/web3.js 1.99.0 and @solana/spl-token 0.4.15 on random keys.
//
// The rule: an address is derived from seeds and a program as the SHA-256 of
// the seeds, the program's address and "ProgramDerivedAddress", and only a
// hash that is not an Ed25519 point is one; the search tries the bump seed
// 255 first, then each lower one down to 1 (web3.js 1.99.0,
// PublicKey.createProgramAddressSync and findProgramAddressSync).

import { decodePublicKey, encodeBase58 } from "./base58.ts";

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 (FIPS 180-4) of bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // The length in bits, big-endian, in the last eight bytes.
  let bits = bytes.length * 8;
  for (let i = padded.length - 1; i >= padded.length - 8; i -= 1) {
    padded[i] = bits % 256;
    bits = Math.floor(bits / 256);
  }
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < blocks; block += 1) {
    for (let t = 0; t < 16; t += 1) {
      const at = block * 64 + t * 4;
      w[t] =
        ((padded[at] << 24) |
          (padded[at + 1] << 16) |
          (padded[at + 2] << 8) |
          padded[at + 3]) >>>
        0;
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (k + s1 + choose + K[t] + w[t]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + k) >>> 0;
  }
  const out = new Uint8Array(32);
  h.forEach((word, i) => {
    out[i * 4] = word >>> 24;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  });
  return out;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
// The field of Ed25519: p = 2^255 - 19.
const P = TWO ** BigInt(255) - BigInt(19);

const mod = (a: bigint): bigint => ((a % P) + P) % P;

function power(base: bigint, exponent: bigint): bigint {
  let result = ONE;
  let b = mod(base);
  let e = exponent;
  while (e > ZERO) {
    if (e % TWO === ONE) result = (result * b) % P;
    b = (b * b) % P;
    e /= TWO;
  }
  return result;
}

// d = -121665 / 121666, the curve's constant.
const D = mod(-BigInt(121665) * power(BigInt(121666), P - TWO));

/**
 * Whether 32 bytes are an Ed25519 point, as a compressed point decompresses:
 * y little-endian with its top bit (x's sign) set aside, taken mod p, is on
 * the curve when (y^2 - 1) / (d y^2 + 1) is a square mod p.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  let y = ZERO;
  for (let i = 31; i >= 0; i -= 1) {
    y = y * BigInt(256) + BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  }
  const yy = mod(y * y);
  const u = mod(yy - ONE);
  const v = mod(D * yy + ONE);
  const xx = mod(u * power(v, P - TWO));
  return xx === ZERO || power(xx, (P - ONE) / TWO) === ONE;
}

const MARKER = Array.from("ProgramDerivedAddress", (c) => c.charCodeAt(0));

/**
 * The address derived from seeds under program, with the first bump seed
 * from 255 down that gives one, or null when no bump does or an address is
 * not a public key.
 */
export function findProgramAddress(
  seeds: readonly string[],
  program: string,
): string | null {
  const keys = [...seeds, program].map(decodePublicKey);
  if (keys.some((key) => key === null)) return null;
  const parts = keys as Uint8Array[];
  for (let bump = 255; bump > 0; bump -= 1) {
    const hash = sha256(
      Uint8Array.from([
        ...parts.slice(0, -1).flatMap((key) => Array.from(key)),
        bump,
        ...Array.from(parts[parts.length - 1]),
        ...MARKER,
      ]),
    );
    if (!isOnCurve(hash)) return encodeBase58(hash);
  }
  return null;
}
