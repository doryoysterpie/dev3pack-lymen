// Account data readers for the pre-flight (E-09). Pure module.
//
// - Token account: solana-program/token 38de8d1, interface/src/state.rs,
//   `impl Pack for Account`: 165 bytes, mint 0..32, owner 32..64, amount
//   64..72, delegate 72..108 (4-byte tag, then the key), delegated amount
//   121..129. Token-2022 accounts start with the same 165 bytes.
// - Lookup table: anza-xyz/solana-sdk 7b382f6,
//   address-lookup-table-interface/src/state.rs: a u32 ProgramState tag
//   (1 = LookupTable), addresses from LOOKUP_TABLE_META_SIZE (56) on.

import { encodeBase58 } from "./base58.ts";

export interface TokenAccount {
  readonly mint: string;
  readonly owner: string;
  readonly amount: string;
  readonly delegate: string | null;
  readonly delegatedAmount: string;
}

const TOKEN_ACCOUNT_LENGTH = 165;
const LOOKUP_TABLE_META_SIZE = 56;

function u64(data: Uint8Array, offset: number): string {
  let value = BigInt(0);
  for (let i = 7; i >= 0; i -= 1) {
    value = value * BigInt(256) + BigInt(data[offset + i]);
  }
  return value.toString();
}

function u32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

/** Reads a token account, or returns null when the data is not one. */
export function parseTokenAccount(data: Uint8Array): TokenAccount | null {
  if (data.length < TOKEN_ACCOUNT_LENGTH) return null;
  const delegateTag = u32(data, 72);
  if (delegateTag !== 0 && delegateTag !== 1) return null;
  return {
    mint: encodeBase58(data.subarray(0, 32)),
    owner: encodeBase58(data.subarray(32, 64)),
    amount: u64(data, 64),
    delegate: delegateTag === 1 ? encodeBase58(data.subarray(76, 108)) : null,
    delegatedAmount: u64(data, 121),
  };
}

/** Reads a lookup table's addresses, or returns null when the data is not one. */
export function parseLookupTable(data: Uint8Array): string[] | null {
  if (data.length < LOOKUP_TABLE_META_SIZE) return null;
  if (u32(data, 0) !== 1) return null;
  const body = data.length - LOOKUP_TABLE_META_SIZE;
  if (body % 32 !== 0) return null;
  const addresses: string[] = [];
  for (
    let offset = LOOKUP_TABLE_META_SIZE;
    offset < data.length;
    offset += 32
  ) {
    addresses.push(encodeBase58(data.subarray(offset, offset + 32)));
  }
  return addresses;
}
