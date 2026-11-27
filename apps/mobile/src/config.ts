/// <reference types="expo/types" />

// App configuration. Expo inlines EXPO_PUBLIC_ variables into the bundle at
// build time, so nothing secret belongs in one: an RPC URL that carries a
// provider key would ship inside the app. With no variable set, the app uses
// the public devnet endpoint, which needs no key. The pre-flight checks the
// endpoint's genesis hash and stops on anything but devnet (D-03).

export const SOLANA_RPC_URL =
  process.env.EXPO_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/** What the wallet shows the user when limen asks to connect. */
export const APP_IDENTITY = { name: "limen" } as const;

/** Mobile Wallet Adapter chain id for devnet. */
export const WALLET_CHAIN = "solana:devnet";
