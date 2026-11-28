// Station display rotation (E-03), with no DOM code. It fetches a signed QR, has the page draw
// it, and fetches the next 30 s after the last request left, or at the QR's deadline if sooner:
//
//   deadline = min(expires_at * 1000, sentAt + (expires_at - issued_at) * 1000) - 5000
//
// on the page's clock, where sentAt is when the request left. The 5 s is the verifier's skew,
// within which the page assumes the station's clock agrees with the API's; it does not check
// that. A QR past its deadline on arrival is not drawn. A QR not shown, stale on arrival or by the
// end of its draw, makes the next fetch wait 5 s. A failed fetch, or one with no answer in 10 s,
// shows why and is retried after 5 s.

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
/** The verifier's clock skew, by which the page stops showing a QR early. */
export const CLOCK_SKEW_MS = 5_000;

/** The deadline of a QR whose request left at `sentAt` (the formula at the top). */
export function deadlineOf(sentAt: number, qr: StationQr): number {
  return (
    Math.min(
      qr.expiresAt * 1000,
      sentAt + (qr.expiresAt - qr.issuedAt) * 1000,
    ) - CLOCK_SKEW_MS
  );
}

export interface RotationDeps {
  /** Fetches one QR. The rotation aborts `signal` when the fetch runs past FETCH_TIMEOUT_MS. */
  readonly fetchQr: (signal: AbortSignal) => Promise<StationQr>;
  /** Shows a view. For a QR it resolves once drawn, false when the QR was not shown. */
  readonly render: (
    view: StationView,
  ) => void | boolean | Promise<void | boolean>;
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
        deps.render({ kind: "refreshing" });
        next = RETRY_AFTER_MS;
      } else {
        const shown = await deps.render({ kind: "qr", ...res, deadline });
        if (stopped) return;
        // The next fetch is timed from the clock after the draw. A QR the page did not show,
        // or whose deadline passed while it was drawn, is treated as stale on arrival.
        const after = deps.now();
        next =
          shown === false || after >= deadline
            ? RETRY_AFTER_MS
            : Math.min(deadline, sentAt + ROTATION_S * 1000) - after;
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

/** Reads the station ID from a query string such as "?station=st-front". */
export function readStationId(
  search: string,
): { station: string } | { error: string } {
  const station = new URLSearchParams(search).get("station") ?? "";
  if (!ID.test(station))
    return { error: "Add ?station=<station ID> to the page address." };
  return { station };
}

/**
 * The signed payload inside a station QR's text, or null when the text is not a station QR. The
 * page does not check the signature.
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

/** The caption under a shown QR, from its signed fields. */
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
