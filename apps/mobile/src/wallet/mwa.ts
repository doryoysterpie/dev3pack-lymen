// Mobile Wallet Adapter calls (E-09). This module needs the native adapter,
// so it runs only in a native build on Android; the Node tests do not load it.

import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";

import { APP_IDENTITY, WALLET_CHAIN } from "../config.ts";
import { encodeBase58 } from "../qr/base58.ts";
import { decodeBase64 } from "../tx/base64.ts";
import { walletAddress } from "./address.ts";

export interface WalletSession {
  readonly address: string;
  readonly authToken: string;
}

/** Asks the wallet to connect on devnet and returns its first account. */
export async function connectWallet(): Promise<WalletSession> {
  return transact(async (wallet) => {
    const auth = await wallet.authorize({
      identity: APP_IDENTITY,
      chain: WALLET_CHAIN,
    });
    const first = auth.accounts[0];
    const address = first === undefined ? null : walletAddress(first);
    if (address === null) {
      throw new Error("the wallet returned no account limen can read");
    }
    return { address, authToken: auth.auth_token };
  });
}

/**
 * Hands the transaction to the wallet to sign and send, and returns the
 * signature in base58. Refuses when the wallet now answers with a different
 * account than the one the pre-flight ran for.
 */
export async function signAndSend(
  session: WalletSession,
  transactionBase64: string,
): Promise<string> {
  return transact(async (wallet) => {
    const auth = await wallet.authorize({
      identity: APP_IDENTITY,
      chain: WALLET_CHAIN,
      auth_token: session.authToken,
    });
    const first = auth.accounts[0];
    const address = first === undefined ? null : walletAddress(first);
    if (address !== session.address) {
      throw new Error(
        "the wallet answered with a different account than the one checked",
      );
    }
    const { signatures } = await wallet.signAndSendTransactions({
      payloads: [transactionBase64],
    });
    const signature =
      signatures[0] === undefined ? null : decodeBase64(signatures[0]);
    if (signature === null || signature.length !== 64) {
      throw new Error("the wallet returned no signature");
    }
    return encodeBase58(signature);
  });
}
