// Station display rotation (E-03). Fetches a signed QR from the API, shows it, and fetches a
// fresh one 30 s after the request for it left, or at its deadline if that comes first. A failed
// fetch clears the QR, shows why, and retries after 5 s; a fetch that takes over 10 s counts as
// failed. This file has no DOM code, and the tests drive it with fakes.
//
// Every time the page acts on comes from the QR's signed payload, issued_at and expires_at in the
// API's whole seconds, read against the page's own clock. That assumes the station's clock
// agrees with the API's within the verifier's 5 s skew; the page does not check it. The answer's
// other fields are not read. A QR's deadline is
//
//   deadline = min(expires_at * 1000, sentAt + (expires_at - issued_at) * 1000)
//
// where sentAt is when the request left, on the page's clock. A QR whose deadline has passed
// when it arrives is not drawn, and the next one is fetched at once. The page (main.ts) reads
// the clock again after drawing a QR, shows it only if its deadline is still ahead, and clears it
// at its deadline.

/** One QR as the page shows it: the QR text and what its signed payload says. */
export interface StationQr {
  readonly qr: string;
  readonly station: string;
  readonly session: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type StationView =
  | ({
      readonly kind: "qr";
      /** The QR's deadline on the page's clock (RotationDeps.now), in milliseconds. */
      readonly deadline: number;
    } & StationQr)
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "refreshing" };

/** The API's rotation interval: a new QR every 30 s. */
export const ROTATION_S = 30;
export const RETRY_AFTER_MS = 5_000;
/** A fetch that takes longer than this is abandoned and retried. */
export const FETCH_TIMEOUT_MS = 10_000;

/** The deadline of a QR whose request left at `sentAt`; see the comment at the top. */
export function deadlineOf(sentAt: number, qr: StationQr): number {
  return Math.min(
    qr.expiresAt * 1000,
    sentAt + (qr.expiresAt - qr.issuedAt) * 1000,
  );
}

export interface RotationDeps {
  /** Fetches one QR. The rotation aborts `signal` when the fetch runs past FETCH_TIMEOUT_MS. */
  readonly fetchQr: (signal: AbortSignal) => Promise<StationQr>;
  readonly render: (view: StationView) => void;
  /** The page's clock, in milliseconds since the Unix epoch, such as Date.now(). */
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/** Starts fetching and showing QRs. Call stop() to end the rotation. */
export function startRotation(deps: RotationDeps): { stop: () => void } {
  let stopped = false;
  let timer: unknown = null;

  const schedule = (ms: number): void => {
    if (!stopped) timer = deps.setTimeout(tick, ms);
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
      const receivedAt = deps.now();
      const deadline = deadlineOf(sentAt, res);
      if (deadline <= receivedAt) {
        // Its deadline passed on the way. It is not drawn; the next one is fetched at once.
        deps.render({ kind: "refreshing" });
        next = 0;
      } else {
        deps.render({ kind: "qr", ...res, deadline });
        next = Math.max(
          0,
          Math.min(deadline, sentAt + ROTATION_S * 1000) - receivedAt,
        );
      }
    } catch (err) {
      if (stopped) return;
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
    },
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Reads the station ID from the page address's query string, such as "?station=st-front". The
 * page passes location.search alone, so it reads no fragment.
 */
export function readStationId(
  search: string,
): { station: string } | { error: string } {
  const station = new URLSearchParams(search).get("station") ?? "";
  if (!ID.test(station))
    return { error: "Add ?station=<station ID> to the page address." };
  return { station };
}

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

/**
 * The caption under a shown QR, from its signed fields. It is a statement, not a countdown,
 * since it does not change while the QR is shown. A QR signed for less than 60 s was cut short
 * by its session's end.
 */
export function captionFor(view: StationQr): string {
  const when =
    view.expiresAt < view.issuedAt + 60
      ? "This QR expires by the session's end."
      : `A new QR every ${ROTATION_S} s.`;
  return `Station ${view.station}, session ${view.session}. ${when}`;
}

/** The QR text in the API's answer; the answer's other fields are not read. */
function qrOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const qr = (value as Record<string, unknown>).qr;
  return typeof qr === "string" && qr.startsWith("limen:station:") ? qr : null;
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
  const qr = qrOf(body);
  const payload = qr === null ? null : stationPayloadOf(qr);
  if (qr === null || payload === null)
    throw new Error(
      "The API answered with something that is not a station QR.",
    );
  // A QR signed for another station is refused, whatever the response's other fields say.
  if (payload.station !== config.station)
    throw new Error("The API sent a QR for another station.");
  return {
    qr,
    station: payload.station,
    session: payload.session,
    issuedAt: payload.issued_at,
    expiresAt: payload.expires_at,
  };
}
