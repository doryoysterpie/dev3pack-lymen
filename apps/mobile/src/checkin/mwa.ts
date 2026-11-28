// The check-in signer bound to the real Mobile Wallet Adapter (E-05, app half). Only the app
// imports this file; the tests drive mwa-signer.ts with a fake transact instead.

import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";

import { ed25519Verify } from "./ed25519.ts";
import { mwaSigner, type Transact } from "./mwa-signer.ts";

export const walletSigner = mwaSigner(transact as unknown as Transact, {
  appName: "limen",
  chain: "solana:devnet",
  verify: ed25519Verify,
});
