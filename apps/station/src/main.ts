// Station display page (E-03), opened as /station?station=<station ID>. It asks for the station's
// display token in a password field, keeps it in memory, and sends it in the Authorization
// header of its requests to /api.
import QRCode from "qrcode";

import {
  captionFor,
  fetchStationQr,
  readStationId,
  startRotation,
  type StationView,
} from "./rotation.ts";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`station page is missing #${id}`);
  return found as T;
}

const canvas = element<HTMLCanvasElement>("qr");
const caption = element<HTMLParagraphElement>("caption");
const problem = element<HTMLParagraphElement>("problem");
const tokenPrompt = element<HTMLDivElement>("token-prompt");
const tokenInput = element<HTMLInputElement>("token");
const tokenStart = element<HTMLButtonElement>("token-start");

function showProblem(message: string): void {
  canvas.hidden = true;
  delete canvas.dataset.qr;
  caption.textContent = "";
  problem.textContent = message;
  problem.hidden = false;
}

function showRefreshing(): void {
  canvas.hidden = true;
  delete canvas.dataset.qr;
  problem.hidden = true;
  caption.textContent = "Refreshing the QR. Please wait.";
}

/** The page's clock: milliseconds since the Unix epoch, read against the QR's signed times. */
const now = (): number => window.Date.now();

// The timer that clears the shown QR, and a count of renders, so a draw that a newer render has
// overtaken shows nothing.
let clearing: number | null = null;
let renders = 0;

/** Shows `view`. For a QR, the promise settles once it is drawn and shown, or refused. */
/** Shows `view`. For a QR, resolves to whether the QR was shown. */
function render(view: StationView): void | Promise<boolean> {
  if (clearing !== null) window.clearTimeout(clearing);
  clearing = null;
  const mine = ++renders;
  if (view.kind === "error") {
    showProblem(view.message);
    return;
  }
  if (view.kind === "refreshing") {
    showRefreshing();
    return;
  }
  return QRCode.toCanvas(canvas, view.qr, {
    width: 480,
    margin: 2,
    errorCorrectionLevel: "M",
  }).then(
    () => {
      if (mine !== renders) return false;
      // The clock is read again after the draw; the QR is shown only with time left, and the
      // clearing timer is armed for that time.
      const left = view.deadline - now();
      if (left <= 0) {
        showRefreshing();
        return false;
      }
      canvas.dataset.qr = view.qr;
      canvas.hidden = false;
      caption.textContent = captionFor(view);
      problem.hidden = true;
      clearing = window.setTimeout(() => {
        clearing = null;
        showRefreshing();
      }, left);
      return true;
    },
    () => {
      if (mine === renders) showProblem("This QR could not be drawn.");
      return false;
    },
  );
}

/** Starts the rotation for `station` with `token`, kept in this closure. */
function show(station: string, token: string): void {
  startRotation({
    fetchQr: (signal) =>
      fetchStationQr(
        window.fetch.bind(window),
        "/api",
        { station, token },
        signal,
      ),
    render,
    now,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });
}

/** Asks for the display token, then starts the rotation once, and clears the field. */
function askForToken(station: string): void {
  let started = false;
  const start = (): void => {
    const token = tokenInput.value;
    tokenInput.value = "";
    if (started || token === "") return;
    started = true;
    tokenPrompt.hidden = true;
    show(station, token);
  };
  tokenStart.addEventListener("click", start);
  tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") start();
  });
  tokenPrompt.hidden = false;
}

// Drops any fragment, such as an old link file's token, without reading it.
window.history.replaceState(
  null,
  "",
  window.location.pathname + window.location.search,
);
const id = readStationId(window.location.search);
if ("error" in id) showProblem(id.error);
else askForToken(id.station);
