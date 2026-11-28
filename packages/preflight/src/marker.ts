// Role markers in place of addresses, and the scrub of addresses from text
// the RPC wrote (E-09). Pure module.
//
// A summary never carries the user's address as text: wherever it would
// appear, the summary writes "user". A report goes further (preflight.ts,
// toReport; the owner's ruling 20a): it carries no address but the six known
// programs in REPORT_PROGRAMS (isReportProgram). Every other address becomes a role marker:
// "account N" for the account at index N of the message's account list,
// "lookup table N" for the table at index N of its lookups, and "address N",
// from 1 in the order first met, for any other, such as a new authority an
// instruction's data names. The reason a simulation is not used, or the
// error it ran into, has every address in it replaced. So the app and a
// server produce the same report for the same bytes and the same RPC answers.

import { decodePublicKey } from "./base58.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";

/** What a summary writes in place of the user's wallet address. */
export const USER_MARKER = "user";

/**
 * The only addresses a report may carry: these programs' IDs. Module-private
 * and frozen, read only through isReportProgram (the audit of 21e1f9f, item
 * 3), so no caller can add to it.
 */
const REPORT_PROGRAMS: readonly string[] = Object.freeze([
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
]);

/** Whether a report may carry this address: one of REPORT_PROGRAMS. */
export function isReportProgram(address: string): boolean {
  return REPORT_PROGRAMS.includes(address);
}

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
 * Replaces every base58 run of 32 or more characters in every string of a
 * plain JSON value, keys included, with SCRUBBED, unless it is one of the
 * programs a report may carry. For text the RPC wrote, which could name any
 * account, alone or inside longer text (the audit of 21e1f9f, item 2): no
 * run that long is kept, whether or not it decodes to 32 bytes.
 */
export function scrubAddresses<T>(value: T): T {
  return mapStrings(value, (text) =>
    text.replace(BASE58_RUN, (run) =>
      run.length >= 32 && !isReportProgram(run) ? SCRUBBED : run,
    ),
  );
}

/**
 * value with every address replaced by its role marker: markers.get(address)
 * when it has one, and otherwise "address N", from 1 in the order first met.
 * An address in REPORT_PROGRAMS, and base58 text that is not a public key,
 * stay as they are. Every string of a plain JSON value is read, keys
 * included.
 */
export function withRoleMarkers<T>(
  value: T,
  markers: ReadonlyMap<string, string>,
): T {
  const others = new Map<string, string>();
  return mapStrings(value, (text) =>
    text.replace(BASE58_RUN, (run) => {
      if (isReportProgram(run)) return run;
      const known = markers.get(run) ?? others.get(run);
      if (known !== undefined) return known;
      if (run.length < 32 || decodePublicKey(run) === null) return run;
      const marker = `address ${others.size + 1}`;
      others.set(run, marker);
      return marker;
    }),
  );
}
