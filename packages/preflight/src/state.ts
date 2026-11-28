// Account data readers for the pre-flight (E-09). Pure module.
//
// - Token account: solana-program/token 38de8d1, interface/src/state.rs:131
//   to 149, `impl Pack for Account`: exactly 165 bytes, mint 0..32, owner
//   32..64, amount 64..72, delegate 72..108 (4-byte tag, then the key), state
//   108 (1 Initialized, 2 Frozen; 0 Uninitialized is not unpacked), is_native
//   109..121 (4-byte tag, then the u64), delegated amount 121..129, close
//   authority 129..165 (4-byte tag, then the key); a tag other than 0 or 1 is
//   InvalidAccountData (:265 to 292).
// - Token-2022 account: solana-program/token-2022 efe55b4,
//   interface/src/extension/mod.rs: the same 165 bytes, then, when longer,
//   the AccountType byte, which must be Account (2) (:316 to 337, :974 to
//   984); never the Multisig length, 355 (:275 to 281).
// - Lookup table: anza-xyz/solana-sdk 7b382f6,
//   address-lookup-table-interface/src/state.rs: a u32 ProgramState tag
//   (1 = LookupTable), addresses from LOOKUP_TABLE_META_SIZE (56) on.

import { encodeBase58 } from "./base58.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./programs.ts";

export interface TokenAccount {
  readonly mint: string;
  readonly owner: string;
  readonly amount: string;
  readonly delegate: string | null;
  readonly delegatedAmount: string;
  readonly closeAuthority: string | null;
}

const TOKEN_ACCOUNT_LENGTH = 165;
const MULTISIG_LENGTH = 355;
/** Token-2022's AccountType for a token account (extension/mod.rs:1056). */
const ACCOUNT_TYPE_ACCOUNT = 2;
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

/**
 * Reads a token account of the program that owns it, or returns null when
 * that program would not unpack the data as an initialized token account:
 * the wrong length for the program, a Token-2022 account type other than
 * Account, an uninitialized or unknown state, or an option tag other than 0
 * or 1. Data owned by any other program is never a token account.
 */
export function parseTokenAccount(
  program: string,
  data: Uint8Array,
): TokenAccount | null {
  if (program === TOKEN_PROGRAM) {
    if (data.length !== TOKEN_ACCOUNT_LENGTH) return null;
  } else if (program === TOKEN_2022_PROGRAM) {
    if (data.length < TOKEN_ACCOUNT_LENGTH || data.length === MULTISIG_LENGTH) {
      return null;
    }
    if (
      data.length > TOKEN_ACCOUNT_LENGTH &&
      data[TOKEN_ACCOUNT_LENGTH] !== ACCOUNT_TYPE_ACCOUNT
    ) {
      return null;
    }
  } else {
    return null;
  }
  const state = data[108];
  if (state !== 1 && state !== 2) return null;
  const delegateTag = u32(data, 72);
  if (delegateTag !== 0 && delegateTag !== 1) return null;
  const nativeTag = u32(data, 109);
  if (nativeTag !== 0 && nativeTag !== 1) return null;
  const closeTag = u32(data, 129);
  if (closeTag !== 0 && closeTag !== 1) return null;
  return {
    mint: encodeBase58(data.subarray(0, 32)),
    owner: encodeBase58(data.subarray(32, 64)),
    amount: u64(data, 64),
    delegate: delegateTag === 1 ? encodeBase58(data.subarray(76, 108)) : null,
    delegatedAmount: u64(data, 121),
    closeAuthority:
      closeTag === 1 ? encodeBase58(data.subarray(133, 165)) : null,
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
