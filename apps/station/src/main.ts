// Station display page (E-03). Shows the signed station QR and replaces it every 30 s.
// Open it as /?station=<station ID>#token=<that station's display token>, the address
// `npm run station-link -w @limen/api` writes. The token sits in the
// fragment, which the browser never sends to a server, and is removed from the address bar
// before anything else happens, an error included. Requests go to /api, which the Vite server forwards to the limen API.
import QRCode from "qrcode";

import {
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

function render(view: StationView): void {
  if (view.kind === "error") {
    showProblem(view.message);
    return;
  }
  if (view.kind === "refreshing") {
    // The last QR has outlived its lifetime and no new one has arrived yet.
    canvas.hidden = true;
    delete canvas.dataset.qr;
    problem.hidden = true;
    caption.textContent = "Refreshing the QR. Please wait.";
    return;
  }
  QRCode.toCanvas(canvas, view.qr, {
    width: 480,
    margin: 2,
    errorCorrectionLevel: "M",
  }).then(
    () => {
      canvas.dataset.qr = view.qr;
      canvas.hidden = false;
      caption.textContent = `Station ${view.station}, session ${view.session}. A new QR every 30 s.`;
      problem.hidden = true;
    },
    () => showProblem("This QR could not be drawn."),
  );
}

// The token leaves the address bar before anything renders, so no copy of this page's address,
// even of an error page, carries it.
const href = window.location.href;
const bare = new URL(href);
bare.hash = "";
window.history.replaceState(null, "", bare);
const config = readStationConfig(href);
if ("error" in config) {
  showProblem(config.error);
} else {
  startRotation({
    fetchQr: (signal) =>
      fetchStationQr(window.fetch.bind(window), "/api", config, signal),
    render,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });
}
