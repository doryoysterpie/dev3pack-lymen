// Station display rotation (E-03). Fetches a signed QR from the API, shows it, and fetches a
// fresh one when the API says to, every 30 s or sooner near a session's end. A failed fetch
// clears the QR, shows why, and retries after 5 s; a fetch that takes over 10 s counts as
// failed. Each answer says how long its QR has left; the page counts its whole round trip off
// that, never draws a QR with no time left, and clears a shown QR when its time runs out.
// This file has no DOM code, and the tests drive it with fakes.

/** What the API returns from GET /stations/:id/qr. */
export interface StationQrResponse {
  readonly qr: string;
  readonly station: string;
  readonly session: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly refresh_after_s: number;
  /** How long the QR has left as it leaves the API, in milliseconds. */
  readonly expires_in_ms: number;
}

/**
 * One QR as the page shows it: the QR text, the station, session and times read from the
 * payload it carries, and the server's refresh interval.
 */
export interface StationQr {
  readonly qr: string;
  readonly station: string;
  readonly session: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly refreshAfterS: number;
  /** How long the QR had left as it left the API, in milliseconds. */
  readonly expiresInMs: number;
}

export type StationView =
  | ({ readonly kind: "qr" } & StationQr)
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "refreshing" };

export const RETRY_AFTER_MS = 5_000;
/** A fetch that takes longer than this is abandoned and retried. */
export const FETCH_TIMEOUT_MS = 10_000;

export interface RotationDeps {
  /** Fetches one QR. The rotation aborts `signal` when the fetch runs past FETCH_TIMEOUT_MS. */
  readonly fetchQr: (signal: AbortSignal) => Promise<StationQr>;
  readonly render: (view: StationView) => void;
  /** A clock in milliseconds that only moves forward, such as performance.now(). */
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/** Starts fetching and showing QRs. Call stop() to end the rotation. */
export function startRotation(deps: RotationDeps): { stop: () => void } {
  let stopped = false;
  let timer: unknown = null;
  let staleTimer: unknown = null;

  const schedule = (ms: number): void => {
    if (!stopped) timer = deps.setTimeout(tick, ms);
  };

  const clearStale = (): void => {
    if (staleTimer !== null) deps.clearTimeout(staleTimer);
    staleTimer = null;
  };

  async function tick(): Promise<void> {
    timer = null;
    let next: number;
    try {
      const sentAt = deps.now();
      const controller = new AbortController();
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error("The API did not answer in time.")),
        );
      });
      const fetchTimer = deps.setTimeout(
        () => controller.abort(),
        FETCH_TIMEOUT_MS,
      );
      let res: StationQr;
      try {
        res = await Promise.race([deps.fetchQr(controller.signal), timedOut]);
      } finally {
        deps.clearTimeout(fetchTimer);
      }
      if (stopped) return;
      clearStale();
      // The QR's time left, less the whole round trip: the API may have issued it as the
      // request left, so this is the most that can be left.
      const elapsed = deps.now() - sentAt;
      const left = res.expiresInMs - elapsed;
      if (left <= 0) {
        // It expired on the way. It is never drawn; the next one is fetched at once.
        deps.render({ kind: "refreshing" });
        next = 0;
      } else {
        deps.render({ kind: "qr", ...res });
        // Once this QR's time has run out on screen, it can no longer check anyone in.
        staleTimer = deps.setTimeout(() => {
          staleTimer = null;
          if (!stopped) deps.render({ kind: "refreshing" });
        }, left);
        // The API's refresh point, or the QR's expiry if sooner, counted from when it was issued.
        next = Math.max(
          0,
          Math.min(res.refreshAfterS * 1000, res.expiresInMs) - elapsed,
        );
      }
    } catch (err) {
      if (stopped) return;
      clearStale();
      deps.render({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      next = RETRY_AFTER_MS;
    }
    schedule(next);
  }

  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) deps.clearTimeout(timer);
      clearStale();
    },
  };
}

/**
 * The value of `name` in an address fragment such as "#token=abc&x=1". Percent escapes are
 * decoded, but "+" stays "+": the fragment is not form data, and a base64 token such as
 * `openssl rand -base64 32` makes often holds "+", "/" and "=".
 */
export function fragmentParam(hash: string, name: string): string | null {
  for (const part of hash.replace(/^#/, "").split("&")) {
    const eq = part.indexOf("=");
    if ((eq === -1 ? part : part.slice(0, eq)) !== name) continue;
    const raw = eq === -1 ? "" : part.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Reads the station ID from ?station= and the display token from #token= in the page URL. */
export function readStationConfig(
  href: string,
): { station: string; token: string } | { error: string } {
  const url = new URL(href);
  const station = url.searchParams.get("station") ?? "";
  const token = fragmentParam(url.hash, "token") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(station)) {
    return { error: "Add ?station=<station ID> to the page address." };
  }
  if (token === "")
    return { error: "Add #token=<display token> to the page address." };
  return { station, token };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The signed payload inside a station QR's text, or null when the text is not a station QR.
 * The page has no key and does not check the signature; it reads what was signed, so what it
 * shows under the QR cannot drift from the QR itself.
 */
export function stationPayloadOf(qr: string): {
  station: string;
  session: string;
  issued_at: number;
  expires_at: number;
} | null {
  const m =
    /^limen:station:v1\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.exec(
      qr,
    );
  if (m?.[1] === undefined) return null;
  let p: unknown;
  try {
    p = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
  if (typeof p !== "object" || p === null) return null;
  const v = p as Record<string, unknown>;
  if (
    typeof v.station !== "string" ||
    !ID.test(v.station) ||
    typeof v.session !== "string" ||
    !ID.test(v.session) ||
    !Number.isSafeInteger(v.issued_at) ||
    !Number.isSafeInteger(v.expires_at)
  )
    return null;
  return {
    station: v.station,
    session: v.session,
    issued_at: v.issued_at as number,
    expires_at: v.expires_at as number,
  };
}

/** The caption under a shown QR: its signed station and session, and the server's interval. */
export function captionFor(view: StationQr): string {
  return `Station ${view.station}, session ${view.session}. Next QR in ${view.refreshAfterS} s.`;
}

function isQrResponse(value: unknown): value is StationQrResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.qr === "string" &&
    v.qr.startsWith("limen:station:") &&
    typeof v.station === "string" &&
    typeof v.session === "string" &&
    Number.isSafeInteger(v.issued_at) &&
    Number.isSafeInteger(v.expires_at) &&
    Number.isSafeInteger(v.refresh_after_s) &&
    (v.refresh_after_s as number) > 0 &&
    Number.isSafeInteger(v.expires_in_ms) &&
    (v.expires_in_ms as number) > 0
  );
}

const STATUS_MESSAGES: Record<number, string> = {
  401: "The API refused the display token.",
  404: "The API does not know this station.",
  409: "No session is open right now.",
  // The Vite proxy answers 502 to 504 when the API behind it is down or slow.
  502: "The API cannot be reached.",
  503: "The API cannot be reached.",
  504: "The API cannot be reached.",
};

/** Fetches one QR from the API at `apiBase`, turning each failure into a message for the screen. */
export async function fetchStationQr(
  fetchFn: typeof fetch,
  apiBase: string,
  config: { station: string; token: string },
  signal?: AbortSignal,
): Promise<StationQr> {
  let res: Response;
  try {
    res = await fetchFn(`${apiBase}/stations/${config.station}/qr`, {
      headers: { authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal,
    });
  } catch {
    throw new Error(
      signal?.aborted
        ? "The API did not answer in time."
        : "The API cannot be reached.",
    );
  }
  if (!res.ok)
    throw new Error(
      STATUS_MESSAGES[res.status] ??
        `The API answered with status ${res.status}.`,
    );
  const body: unknown = await res.json().catch(() => null);
  const payload = isQrResponse(body) ? stationPayloadOf(body.qr) : null;
  if (!isQrResponse(body) || payload === null)
    throw new Error(
      "The API answered with something that is not a station QR.",
    );
  // A QR signed for another station is refused, whatever the response's other fields say.
  if (payload.station !== config.station)
    throw new Error("The API sent a QR for another station.");
  return {
    qr: body.qr,
    station: payload.station,
    session: payload.session,
    issuedAt: payload.issued_at,
    expiresAt: payload.expires_at,
    refreshAfterS: body.refresh_after_s,
    expiresInMs: body.expires_in_ms,
  };
}
