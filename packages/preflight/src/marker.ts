// Role markers for the user's wallet and its token accounts, and the scrub of
// addresses from text the RPC wrote (E-09). Pure module.
//
// A summary never carries the user's address as text: wherever it would
// appear, the summary writes "user". A report goes further (preflight.ts,
// toReport): it writes "user token account 1", "user token account 2" and so
// on for the wallet's token accounts, and the reason a simulation is not used,
// or the error it ran into, has every address in it replaced. So the app and a
// server produce the same report for the same bytes, and a report names
// neither the wallet nor one of the token accounts limen found to be its own.

import { decodePublicKey } from "./base58.ts";

/** What a summary writes in place of the user's wallet address. */
export const USER_MARKER = "user";

/** A report writes this, then a number from 1, for each wallet token account. */
export const USER_TOKEN_ACCOUNT_MARKER = "user token account";

/**
 * A report writes this, then a number from 1, for each other token account a
 * token instruction acts on with the wallet as its signing authority, owner
 * or delegate, where nothing shows the wallet owns it; and, when no account
 * was read, for the destination of such a transfer, which could be another
 * of the wallet's token accounts.
 */
export const USER_AUTHORIZED_TOKEN_ACCOUNT_MARKER =
  "user-authorized token account";

/**
 * A report writes this, then a number from 1, for every other account in the
 * account list of an instruction the wallet signs (summary.ts,
 * walletSignedAccounts), whatever its position: any could be one of the
 * wallet's accounts. The stored transaction bytes still name each one.
 */
export const WALLET_SIGNED_ACCOUNT_MARKER =
  "account in a wallet-signed instruction";

/** What scrubAddresses writes in place of an address. */
export const SCRUBBED = "an address";

// A run of base58 characters. Only a whole run is ever replaced, so an
// address inside a longer run is left alone.
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;

// Keys too: an object the RPC wrote, such as an error, can be keyed by an
// address.
function mapStrings<T>(value: T, map: (text: string) => string): T {
  if (typeof value === "string") return map(value) as T;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => mapStrings(item, map)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        map(key),
        mapStrings(item, map),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Writes each address's marker in place of the address, in every string of a
 * plain JSON value, keys included.
 */
export function withMarkers<T>(
  value: T,
  markers: ReadonlyMap<string, string>,
): T {
  return mapStrings(value, (text) =>
    text.replace(BASE58_RUN, (run) => markers.get(run) ?? run),
  );
}

/** withMarkers for the user's wallet alone. */
export function withMarker<T>(value: T, user: string): T {
  return withMarkers(value, new Map([[user, USER_MARKER]]));
}

/**
 * Replaces every address (a base58 run that decodes to 32 bytes) in every
 * string of a plain JSON value, keys included, with SCRUBBED. For text the
 * RPC wrote, which could name any account.
 */
export function scrubAddresses<T>(value: T): T {
  return mapStrings(value, (text) =>
    text.replace(BASE58_RUN, (run) =>
      run.length >= 32 && decodePublicKey(run) !== null ? SCRUBBED : run,
    ),
  );
}

/**
 * Replaces each of the given addresses wherever it occurs in every string of
 * a plain JSON value, keys included, inside a longer run too, with SCRUBBED.
 * For text the RPC wrote, with the wallet's address and its token accounts'.
 */
export function scrubWithin<T>(value: T, addresses: readonly string[]): T {
  return mapStrings(value, (text) =>
    addresses.reduce((out, address) => out.split(address).join(SCRUBBED), text),
  );
}
