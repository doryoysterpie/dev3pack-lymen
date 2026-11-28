// The one Solana RPC endpoint limen calls (D-03: devnet only). Solana's "Clusters and Public RPC
// Endpoints" page (https://solana.com/docs/references/clusters, read 2026-11-28) lists it as
// Devnet's endpoint. No other host is allowed, so no request goes anywhere else; the genesis
// hash check in pass-mint.ts stays as a second guard. This module imports nothing from
// @solana/web3.js, so start-up can check SOLANA_RPC_URL without loading it.
export const DEVNET_ENDPOINT = "https://api.devnet.solana.com";

/**
 * The endpoint to use for SOLANA_RPC_URL: DEVNET_ENDPOINT when it is unset, empty or exactly
 * DEVNET_ENDPOINT. Any other value is refused, and the error does not echo it, since an RPC URL
 * can carry a provider key.
 */
export function devnetEndpoint(url: string | undefined): string {
  if (url === undefined || url === "" || url === DEVNET_ENDPOINT)
    return DEVNET_ENDPOINT;
  throw new Error(
    "SOLANA_RPC_URL must be https://api.devnet.solana.com, the one devnet endpoint limen calls (D-03); unset, it is used.",
  );
}
