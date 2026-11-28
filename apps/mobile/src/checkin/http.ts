// App HTTP requests (E-05, app half). Every HTTP request the app makes goes through appFetch
// with redirect: "error" over expo/fetch, never global fetch, so neither a 307 or 308 response
// nor Expo's React Native fetch opt-in (EXPO_PUBLIC_USE_RN_FETCH) can resend a POST body (such as
// a check-in's plain registration ID) to another origin.

import { fetch as expoFetch } from "expo/fetch";

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Sends one HTTP request with `redirect: "error"`, ignoring any other redirect mode a caller
 * passed. Defaults to `expo/fetch`, never global `fetch`; tests may supply another transport.
 */
export function appFetch(
  url: string,
  init: RequestInit = {},
  transport: HttpFetch = expoFetch as unknown as HttpFetch,
): Promise<Response> {
  return transport(url, { ...init, redirect: "error" });
}
