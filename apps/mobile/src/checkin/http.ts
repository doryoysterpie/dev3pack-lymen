// App HTTP requests (E-05, app half). Every HTTP request the app makes goes through appFetch
// with redirect: "error", so a 307 or 308 response never resends a POST body (such as a
// check-in's plain registration ID) to another origin.

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Sends one HTTP request with `redirect: "error"`, ignoring any other redirect mode a caller
 * passed. Defaults to global `fetch`; tests may supply another transport.
 */
export function appFetch(
  url: string,
  init: RequestInit = {},
  transport: HttpFetch = fetch,
): Promise<Response> {
  return transport(url, { ...init, redirect: "error" });
}
