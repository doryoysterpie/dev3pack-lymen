// Role markers for the user's wallet and its token accounts, and the scrub of
// addresses from text the RPC wrote (E-09). Pure module.
//
// A summary never carries the user's address as text: wherever it would
// appear, the summary writes "user". A report goes further (preflight.ts,
// toReport): it writes "user token account 1", "user token account 2" and so
// on for the wallet's token accounts, and the reason a simulation did not run,
// or the error it ran into, has every address in it replaced. So the app and a
// server produce the same report for the same bytes, and a report names
// neither the wallet nor one of the token accounts limen found to be its own.

import { decodePublicKey } from "./base58.ts";

/** What a summary writes in place of the user's wallet address. */
export const USER_MARKER = "user";

/** A report writes this, then a number from 1, for each wallet token account. */
export const USER_TOKEN_ACCOUNT_MARKER = "user token account";

/** What scrubAddresses writes in place of an address. */
export const SCRUBBED = "an address";

// A run of base58 characters. Only a whole run is ever replaced, so an
// address inside a longer run is left alone.
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;

function mapStrings<T>(value: T, map: (text: string) => string): T {
  if (typeof value === "string") return map(value) as T;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => mapStrings(item, map)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]),
    ) as T;
  }
  return value;
}

/**
 * Writes each address's marker in place of the address, in every string of a
 * plain JSON value: strings, arrays and objects, values only, never keys.
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
 * string of a plain JSON value with SCRUBBED. For text the RPC wrote, which
 * could name any account.
 */
export function scrubAddresses<T>(value: T): T {
  return mapStrings(value, (text) =>
    text.replace(BASE58_RUN, (run) =>
      run.length >= 32 && decodePublicKey(run) !== null ? SCRUBBED : run,
    ),
  );
}
