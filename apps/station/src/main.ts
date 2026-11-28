// Station display page (E-03). Shows the signed station QR and replaces it when the API says.
// Open it as /?station=<station ID>#token=<that station's display token>, the address
// `npm run station-link -w @limen/api` writes. The token sits in the fragment, which the
// browser does not send to a server. index.html's inline script removes it from the address bar
// and the current history entry before this module runs (see takeStationAddress). Requests go
// to /api, which the Vite dev and preview servers forward to the limen API.
import QRCode from "qrcode";

import {
  captionFor,
  fetchStationQr,
  readStationConfig,
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

function render(view: StationView): void {
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
      // Drawing takes time, so the deadline is checked again just before the QR is shown.
      if (window.performance.now() >= view.deadline) {
        showRefreshing();
        return;
      }
      canvas.dataset.qr = view.qr;
      canvas.hidden = false;
      caption.textContent = captionFor(view);
      problem.hidden = true;
    },
    () => showProblem("This QR could not be drawn."),
  );
}

// index.html's first script took the address, token included, before anything loaded, and
// removed the token from the address bar and the current history entry. The module reads the
// address from there and deletes it. If that script did not run, the module removes the token
// itself before reading its configuration.
function takeStationAddress(): string {
  const w = window as unknown as { limenStationAddress?: unknown };
  const kept = w.limenStationAddress;
  delete w.limenStationAddress;
  if (typeof kept === "string") return kept;
  const own = window.location.href;
  const bare = new URL(own);
  bare.hash = "";
  window.history.replaceState(null, "", bare);
  return own;
}

const href = takeStationAddress();
const config = readStationConfig(href);
if ("error" in config) {
  showProblem(config.error);
} else {
  startRotation({
    fetchQr: (signal) =>
      fetchStationQr(window.fetch.bind(window), "/api", config, signal),
    render,
    now: () => window.performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });
}
