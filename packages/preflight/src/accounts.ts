// Account key list of a parsed message (E-09, audited). Pure module.
//
// Order and flags follow anza-xyz/solana-sdk at commit 7b382f6: the static
// keys, then every writable lookup address (table by table, in message order),
// then every readonly lookup address (message/src/versions/v0/mod.rs, field
// docs of `instructions`). Signer and writable flags follow is_signer and
// is_writable_index in message/src/versions/v0/loaded.rs.

import type { ParsedMessage } from "./wire.ts";

export interface Account {
  /** null when the address sits in a lookup table not among the tables given. */
  readonly address: string | null;
  readonly signer: boolean;
  readonly writable: boolean;
  /** Set for an address loaded from a lookup table. */
  readonly lookup: { readonly table: string; readonly index: number } | null;
}

/** Lookup table addresses by table address, as read from the chain. */
export type LookupTables = ReadonlyMap<string, readonly string[]>;

function staticWritable(message: ParsedMessage, index: number): boolean {
  const { header, staticKeys } = message;
  const signed = header.numRequiredSignatures;
  if (index < signed) {
    return index < signed - header.numReadonlySignedAccounts;
  }
  const writableUnsigned =
    staticKeys.length - signed - header.numReadonlyUnsignedAccounts;
  return index - signed < writableUnsigned;
}

/**
 * Lists every account the message's instructions can index. An address from a
 * lookup table that was not loaded, or an index past the end of a loaded
 * table, comes back with address null; the runtime would refuse the latter.
 */
export function messageAccounts(
  message: ParsedMessage,
  tables: LookupTables,
): Account[] {
  const accounts: Account[] = message.staticKeys.map((address, index) => ({
    address,
    signer: index < message.header.numRequiredSignatures,
    writable: staticWritable(message, index),
    lookup: null,
  }));

  const loaded = (writable: boolean) => {
    for (const reference of message.lookups) {
      const table = tables.get(reference.table);
      const indexes = writable
        ? reference.writableIndexes
        : reference.readonlyIndexes;
      for (const index of indexes) {
        accounts.push({
          address: table?.[index] ?? null,
          signer: false,
          writable,
          lookup: { table: reference.table, index },
        });
      }
    }
  };
  loaded(true);
  loaded(false);
  return accounts;
}
