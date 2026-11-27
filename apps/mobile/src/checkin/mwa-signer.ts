// Signing the check-in message through Mobile Wallet Adapter (E-05, app half). Pure module: MWA's
// transact() is passed in (mwa.ts binds the real one), so the Node tests drive it with a fake.
//
// In one MWA session: authorize on devnet, take the first account, build the message for that
// account's address, ask the wallet to sign it, and check the result before anything is sent.
// A wallet's signed message is the message followed by one 64-byte Ed25519 signature per
// signer; the MWA fake wallet builds it that way (SolanaSigningUseCase.signMessage in
// solana-mobile/mobile-wallet-adapter, commit 2695142).

import { decodeBase58 } from "../qr/base58.ts";
import { encodeBase64 } from "./base64.ts";
import type { WalletSigner } from "./flow.ts";
import type { Ed25519Verify } from "./station-qr.ts";
import { decodeBase64, encodeBase58 } from "./wallet-address.ts";

/** The part of MWA's MobileWallet this module uses. */
export interface MwaWallet {
  authorize(params: {
    identity: { name?: string };
    chain?: string;
  }): Promise<{ readonly accounts: readonly { readonly address: string }[] }>;
  signMessages(params: {
    addresses: string[];
    payloads: string[];
  }): Promise<{ readonly signed_payloads: readonly string[] }>;
}

export type Transact = <T>(
  callback: (wallet: MwaWallet) => Promise<T>,
) => Promise<T>;

/** The signature in a signed message from the wallet, or null unless it is `message` plus 64 bytes. */
export function signatureFromSignedPayload(
  signed: Uint8Array,
  message: Uint8Array,
): Uint8Array | null {
  if (signed.length !== message.length + 64) return null;
  for (let i = 0; i < message.length; i++)
    if (signed[i] !== message[i]) return null;
  return signed.slice(message.length);
}

/** An account's 32-byte key and base58 address: MWA sends base64; a wallet-standard account, base58. */
function accountKey(
  address: string,
): { key: Uint8Array; base58: string } | null {
  const fromBase64 = decodeBase64(address);
  if (fromBase64 !== null && fromBase64.length === 32)
    return { key: fromBase64, base58: encodeBase58(fromBase64) };
  const fromBase58 = decodeBase58(address);
  if (fromBase58 !== null && fromBase58.length === 32)
    return { key: fromBase58, base58: address };
  return null;
}

export function mwaSigner(
  transact: Transact,
  opts: {
    readonly appName: string;
    readonly chain: string;
    readonly verify: Ed25519Verify;
  },
): WalletSigner {
  return {
    signCheckin: (build) =>
      transact(async (wallet) => {
        const auth = await wallet.authorize({
          identity: { name: opts.appName },
          chain: opts.chain,
        });
        const account = auth.accounts[0];
        if (account === undefined)
          throw new Error("The wallet authorized no account.");
        const named = accountKey(account.address);
        if (named === null)
          throw new Error("The wallet's account is not a 32-byte key.");
        const message = build(named.base58);
        if (message === null)
          throw new Error("There is no check-in message to sign.");
        const { signed_payloads } = await wallet.signMessages({
          addresses: [account.address],
          payloads: [encodeBase64(message)],
        });
        const signed = decodeBase64(signed_payloads[0] ?? "");
        const signature =
          signed === null ? null : signatureFromSignedPayload(signed, message);
        if (signature === null || !opts.verify(named.key, message, signature)) {
          throw new Error(
            "The wallet's signature does not verify for its own key.",
          );
        }
        return { wallet: named.base58, signature };
      }),
  };
}
