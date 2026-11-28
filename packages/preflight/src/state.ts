// Account data readers for the pre-flight (E-09). Pure module. Since the
// owner's ruling 20a limen reads no token account, so the one reader left is
// the lookup table's, which decoding a version 0 transaction needs.
//
// - Lookup table: anza-xyz/solana-sdk 7b382f6,
//   address-lookup-table-interface/src/state.rs: a u32 ProgramState tag
//   (1 = LookupTable), addresses from LOOKUP_TABLE_META_SIZE (56) on.

import { encodeBase58 } from "./base58.ts";

const LOOKUP_TABLE_META_SIZE = 56;

function u32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
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
