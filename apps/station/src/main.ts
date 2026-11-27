// Station display page (E-03). Shows the signed station QR and replaces it every 30 s.
// Open it as /?station=<station ID>#token=<STATION_DISPLAY_TOKEN>. The token sits in the
// fragment, which the browser never sends to a server, and is removed from the address bar
// once read. Requests go to /api, which the Vite server forwards to the limen API.
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

const config = readStationConfig(window.location.href);
if ("error" in config) {
  showProblem(config.error);
} else {
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", url);
  startRotation({
    fetchQr: () => fetchStationQr(window.fetch.bind(window), "/api", config),
    render,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });
}
