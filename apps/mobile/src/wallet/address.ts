// Wallet account address (E-09). Pure module.
//
// The Mobile Wallet Adapter protocol returns an account address as the base64
// of the public key (Base64EncodedAddress in
// @solana-mobile/mobile-wallet-adapter-protocol 3.0.2, lib/types/index.d.ts).
// A wallet-standard account carries the key bytes as publicKey instead.

import { decodeBase64, encodeBase58 } from "@limen/preflight";

export interface WalletAccountLike {
  readonly address: string;
  readonly publicKey?: ArrayLike<number>;
}

/** The account's base58 address, or null when it does not hold 32 bytes. */
export function walletAddress(account: WalletAccountLike): string | null {
  const bytes =
    account.publicKey === undefined
      ? decodeBase64(account.address)
      : Uint8Array.from(account.publicKey);
  return bytes !== null && bytes.length === 32 ? encodeBase58(bytes) : null;
}
