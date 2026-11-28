// Station display tokens (E-03), each derived from the STATION_DISPLAY_TOKEN secret and a station
// ID.
import { createHmac } from "node:crypto";

/** The shortest STATION_DISPLAY_TOKEN accepted. */
export const MIN_STATION_SECRET_LENGTH = 32;

/** Reads STATION_DISPLAY_TOKEN. The error says whether it is unset or short, not its value. */
export function parseStationDisplaySecret(value: string | undefined): string {
  if (value === undefined || value.length < MIN_STATION_SECRET_LENGTH) {
    throw new Error(
      `STATION_DISPLAY_TOKEN must be set to at least ${MIN_STATION_SECRET_LENGTH} characters (${value === undefined || value === "" ? "it is not set" : "it is too short"}). To add one to .env without printing it, run from the repository root: { echo; openssl rand -base64 32 | sed 's/^/STATION_DISPLAY_TOKEN=/'; } >> .env`,
    );
  }
  return value;
}

/**
 * The display token for `station`: HMAC-SHA256, keyed with the secret, of
 * "limen:station-display:v1:<station>", in base64url without padding (43 characters).
 */
export function stationDisplayToken(secret: string, station: string): string {
  return createHmac("sha256", secret)
    .update(`limen:station-display:v1:${station}`, "utf8")
    .digest("base64url");
}
