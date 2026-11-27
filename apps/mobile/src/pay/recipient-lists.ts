// Organizer allowlist and flagged list for payment recipients (E-08). Flagged
// means only that an address is on the bundled devnet list.
// Pure module: the lists are passed in, so the source of the lists can change
// without touching the checks.

import { decodePublicKey } from "@limen/preflight";

export interface RecipientLists {
  readonly organizers: ReadonlySet<string>;
  readonly flagged: ReadonlySet<string>;
}

export type RecipientStatus = "organizer" | "flagged" | "unlisted";

function addressSet(value: unknown, field: string): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    throw new Error(`recipient lists: ${field} must be an array`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || decodePublicKey(entry) === null) {
      throw new Error(
        `recipient lists: ${field} holds an entry that is not a public key`,
      );
    }
  }
  return new Set(value as string[]);
}

/**
 * Reads lists of the form { "organizers": [...], "flagged": [...] }. Throws
 * when either field is missing or holds an entry that is not a public key, so
 * a broken list fails at load instead of matching nothing.
 */
export function loadRecipientLists(json: unknown): RecipientLists {
  if (typeof json !== "object" || json === null) {
    throw new Error("recipient lists: expected an object");
  }
  const record = json as Record<string, unknown>;
  return {
    organizers: addressSet(record.organizers, "organizers"),
    flagged: addressSet(record.flagged, "flagged"),
  };
}

/**
 * A recipient on the flagged list is flagged even when it is also on the
 * organizer list: the warning wins over the reassurance.
 */
export function recipientStatus(
  address: string,
  lists: RecipientLists,
): RecipientStatus {
  if (lists.flagged.has(address)) return "flagged";
  if (lists.organizers.has(address)) return "organizer";
  return "unlisted";
}
