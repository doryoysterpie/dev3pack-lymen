// Station display rotation (E-03). Fetches a signed QR from the API, shows it, and fetches a
// fresh one 30 s after the request for it left, or at its deadline if that comes first. A failed
// fetch clears the QR, shows why, and retries after 5 s; a fetch that takes over 10 s counts as
// failed. This file has no DOM code, and the tests drive it with fakes.
//
// Every time the page acts on comes from the QR's signed payload: issued_at and expires_at, in
// the API's whole seconds. The answer's other fields are not read. The API signed the QR at some
// instant in [issued_at, issued_at + 999 ms] on its clock, while the request was out, so on the
// page's clock the QR expires no earlier than its deadline:
//
//   deadline = sentAt + (expires_at - issued_at) * 1000 - 999
//
// where sentAt is when the request left. A QR already past its deadline when it arrives is not
// drawn, and a shown QR is cleared at its deadline.

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
      /** The QR's deadline on the rotation's own clock (RotationDeps.now), in milliseconds. */
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
  return sentAt + (qr.expiresAt - qr.issuedAt) * 1000 - 999;
}

export interface RotationDeps {
  /** Fetches one QR. The rotation aborts `signal` when the fetch runs past FETCH_TIMEOUT_MS. */
  readonly fetchQr: (signal: AbortSignal) => Promise<StationQr>;
  readonly render: (view: StationView) => void;
  /** A monotonic clock in milliseconds, such as performance.now(). */
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
      const receivedAt = deps.now();
      const deadline = deadlineOf(sentAt, res);
      if (deadline <= receivedAt) {
        // Its deadline passed on the way. It is not drawn; the next one is fetched at once.
        deps.render({ kind: "refreshing" });
        next = 0;
      } else {
        deps.render({ kind: "qr", ...res, deadline });
        staleTimer = deps.setTimeout(() => {
          staleTimer = null;
          if (!stopped) deps.render({ kind: "refreshing" });
        }, deadline - receivedAt);
        next = Math.max(
          0,
          Math.min(deadline, sentAt + ROTATION_S * 1000) - receivedAt,
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
 * decoded, but "+" stays "+", since the fragment is not form data. The display token itself is
 * a base64url HMAC (services/api/src/station-token.ts), with no "+", "/" or "=", so neither
 * rule changes it.
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
