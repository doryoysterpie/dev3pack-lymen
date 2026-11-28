// Station display page (E-03). Shows the signed station QR and replaces it when the API says.
// Open it as /?station=<station ID>. The page asks for that station's display token, which
// `npm run station-token -w @limen/api -- <station ID>` copies to the clipboard, in a password
// field. It keeps the token in this module's memory and sends it only in the Authorization
// header of its requests; it does not write it to the address, the history, a cookie or
// storage, so a reload asks for it again. Requests go to /api, which the Vite dev and preview
// servers forward to the limen API.
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

// The timer that clears the shown QR at its deadline, and a count of the renders, so a slow draw
// that a newer render has overtaken shows nothing.
let clearing: number | null = null;
let renders = 0;

function render(view: StationView): void {
  if (clearing !== null) window.clearTimeout(clearing);
  clearing = null;
  const mine = ++renders;
  if (view.kind === "error") {
    showProblem(view.message);
    return;
  }
  if (view.kind === "refreshing") {
    // The last QR has passed its deadline and no new one has arrived yet.
    showRefreshing();
    return;
  }
  QRCode.toCanvas(canvas, view.qr, {
    width: 480,
    margin: 2,
    errorCorrectionLevel: "M",
  }).then(
    () => {
      if (mine !== renders) return;
      // Drawing takes time, so the clock is read again now: the QR is shown only if its
      // deadline is still ahead, and the clearing timer is armed for what is left.
      const left = view.deadline - now();
      if (left <= 0) {
        showRefreshing();
        return;
      }
      canvas.dataset.qr = view.qr;
      canvas.hidden = false;
      caption.textContent = captionFor(view);
      problem.hidden = true;
      clearing = window.setTimeout(() => {
        clearing = null;
        showRefreshing();
      }, left);
    },
    () => {
      if (mine === renders) showProblem("This QR could not be drawn.");
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

// An address from an earlier version's link file carries a token in its fragment. The page
// replaces its address with its path and query, without reading the fragment.
window.history.replaceState(
  null,
  "",
  window.location.pathname + window.location.search,
);
const id = readStationId(window.location.search);
if ("error" in id) showProblem(id.error);
else askForToken(id.station);
