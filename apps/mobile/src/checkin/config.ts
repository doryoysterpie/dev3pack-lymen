/// <reference types="expo/types" />

// Check-in configuration (E-05, app half). Expo inlines EXPO_PUBLIC_ variables into the bundle
// at build time, so nothing secret belongs here.
//
//   EXPO_PUBLIC_API_URL           the limen API, shared with the report panel (E-10 app side).
//                                 On the Android emulator the host's 127.0.0.1:8787 is
//                                 http://10.0.2.2:8787. Unset: the app has no check-in server.
//   EXPO_PUBLIC_STATION_SIGNERS   comma-separated signer IDs (base64url of each 32-byte public
//                                 key, as station QRs carry them) of the keys allowed to sign
//                                 station QRs: the organizer key. Unset: no QR verifies.

/** The API base URL without a trailing slash, or null when unset or not http(s). */
export function parseApiUrl(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!/^https?:\/\/[^\s]+$/.test(text)) return null;
  return text.replace(/\/+$/, "");
}

/** The allowlist of station signer IDs: 43-character base64url strings, others dropped. */
export function parseStationSigners(
  value: string | undefined,
): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9_-]{43}$/.test(s)),
  );
}

export const CHECKIN_API_URL = parseApiUrl(process.env.EXPO_PUBLIC_API_URL);
export const STATION_SIGNERS = parseStationSigners(
  process.env.EXPO_PUBLIC_STATION_SIGNERS,
);
