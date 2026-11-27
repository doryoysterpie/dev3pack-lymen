// Station display rotation (E-03). Fetches a signed QR from the API, shows it, and fetches a
// fresh one when the API says to, every 30 s. A failed fetch clears the QR, shows why, and
// retries after 5 s. This file has no DOM or network code, so the tests drive it with fakes.

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
  | { readonly kind: "error"; readonly message: string };

export const RETRY_AFTER_MS = 5_000;

export interface RotationDeps {
  readonly fetchQr: () => Promise<StationQrResponse>;
  readonly render: (view: StationView) => void;
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
      const res = await deps.fetchQr();
      if (stopped) return;
      deps.render({
        kind: "qr",
        qr: res.qr,
        station: res.station,
        session: res.session,
        expiresAt: res.expires_at,
      });
      next = res.refresh_after_s * 1000;
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

/** Reads the station ID from ?station= and the display token from #token= in the page URL. */
export function readStationConfig(
  href: string,
): { station: string; token: string } | { error: string } {
  const url = new URL(href);
  const station = url.searchParams.get("station") ?? "";
  const token =
    new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? "";
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
};

/** Fetches one QR from the API at `apiBase`, turning each failure into a message for the screen. */
export async function fetchStationQr(
  fetchFn: typeof fetch,
  apiBase: string,
  config: { station: string; token: string },
): Promise<StationQrResponse> {
  let res: Response;
  try {
    res = await fetchFn(`${apiBase}/stations/${config.station}/qr`, {
      headers: { authorization: `Bearer ${config.token}` },
      cache: "no-store",
    });
  } catch {
    throw new Error("The API cannot be reached.");
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
