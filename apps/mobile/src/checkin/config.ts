/// <reference types="expo/types" />

// Check-in configuration (E-05, app half). Expo inlines EXPO_PUBLIC_ variables into the bundle
// at build time, so nothing secret belongs here.
//
//   EXPO_PUBLIC_API_URL           the limen API, shared with the report panel (E-10 app side).
//                                 Must use https://, except http:// on loopback and emulator
//                                 hosts (localhost, 127.0.0.1, 10.0.2.2) for development.
//                                 Unset or refused: the app has no check-in server.
//   EXPO_PUBLIC_STATION_SIGNERS   comma-separated signer IDs (base64url of each 32-byte public
//                                 key, as station QRs carry them) of the keys allowed to sign
//                                 station QRs: the organizer key. Unset: no QR verifies.

import { URL } from "whatwg-url-minimum";

const DEV_HTTP_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "10.0.2.2",
]);

/**
 * The API base URL without a trailing slash, or null unless it is `https://` (or `http://` on
 * `localhost`, `127.0.0.1` or `10.0.2.2` for development) with no credentials, query or fragment.
 */
export function parseApiUrl(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!/^https?:\/\/[^\s\\]+$/i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  if (url.protocol === "http:") {
    const rawHost =
      /^http:\/\/([^/:?#]+)/i.exec(text)?.[1]?.toLowerCase() ?? "";
    if (!DEV_HTTP_HOSTS.has(url.hostname) || !DEV_HTTP_HOSTS.has(rawHost)) {
      return null;
    }
  } else if (url.protocol !== "https:") {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
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
