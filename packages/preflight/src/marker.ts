// The role marker for the user's wallet (E-09). Pure module.
//
// A summary never carries the user's address as text: wherever it would
// appear, the summary writes "user". So the app and a server produce the same
// summary for the same bytes, and a stored report holds no wallet address.

/** What a summary writes in place of the user's wallet address. */
export const USER_MARKER = "user";

/**
 * Writes the role marker in place of the user's address in every string of a
 * plain JSON value: strings, arrays and objects, values only, never keys.
 */
export function withMarker<T>(value: T, user: string): T {
  if (typeof value === "string") {
    return value.split(user).join(USER_MARKER) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withMarker(item, user)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withMarker(item, user)]),
    ) as T;
  }
  return value;
}
