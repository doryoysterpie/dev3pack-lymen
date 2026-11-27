// Station display rotation (E-03). Fetches a signed QR from the API, shows it, and fetches a
// fresh one when the API says to, every 30 s. A failed fetch clears the QR, shows why, and
// retries after 5 s; a fetch that takes over 10 s counts as failed. If a QR outlives its own
// lifetime on screen before a new one arrives, it is cleared and the page says it is refreshing.
// This file has no DOM code, and the tests drive it with fakes.

/** What the API returns from GET /stations/:id/qr. */
export interface StationQrResponse {
  readonly qr: string;
  readonly station: string;
  readonly session: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly refresh_after_s: number;
}

export type StationView =
  | {
      readonly kind: "qr";
      readonly qr: string;
      readonly station: string;
      readonly session: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "refreshing" };

export const RETRY_AFTER_MS = 5_000;
/** A fetch that takes longer than this is abandoned and retried. */
export const FETCH_TIMEOUT_MS = 10_000;

export interface RotationDeps {
  /** Fetches one QR. The rotation aborts `signal` when the fetch runs past FETCH_TIMEOUT_MS. */
  readonly fetchQr: (signal: AbortSignal) => Promise<StationQrResponse>;
  readonly render: (view: StationView) => void;
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
      let res: StationQrResponse;
      try {
        res = await Promise.race([deps.fetchQr(controller.signal), timedOut]);
      } finally {
        deps.clearTimeout(fetchTimer);
      }
      if (stopped) return;
      clearStale();
      deps.render({
        kind: "qr",
        qr: res.qr,
        station: res.station,
        session: res.session,
        expiresAt: res.expires_at,
      });
      // Once this QR's lifetime has run out on screen, it can no longer check anyone in.
      staleTimer = deps.setTimeout(
        () => {
          staleTimer = null;
          if (!stopped) deps.render({ kind: "refreshing" });
        },
        (res.expires_at - res.issued_at) * 1000,
      );
      next = res.refresh_after_s * 1000;
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

/** Reads the station ID from ?station= and the display token from #token= in the page URL. */
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
    (v.refresh_after_s as number) > 0
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
): Promise<StationQrResponse> {
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
  if (!isQrResponse(body))
    throw new Error(
      "The API answered with something that is not a station QR.",
    );
  return body;
}
