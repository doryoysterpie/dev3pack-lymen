// limen triage dashboard (E-12). Plain browser script, no framework. Every value from the API
// is written with textContent, never as HTML.
/* global document, window */

const TOKEN_KEY = "limen-triage-token";
const $ = (id) => document.getElementById(id);
let currentCase = null;

function token() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function say(text) {
  $("message").textContent = text;
}

async function api(path, method = "GET") {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token()}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("The token was refused.");
  if (res.status === 503) throw new Error("The API has no triage token set.");
  if (!res.ok)
    throw new Error(
      `The API answered ${res.status} (${body.error ?? "no detail"}).`,
    );
  return body;
}

const time = (seconds) =>
  new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const yesNo = (value) => (value ? "yes" : "no");

function cell(row, text) {
  const td = document.createElement("td");
  td.textContent = text;
  row.append(td);
  return td;
}

async function showCases() {
  const { cases } = await api("/cases");
  const body = $("cases");
  body.replaceChildren();
  for (const c of cases) {
    const row = document.createElement("tr");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "link";
    link.textContent = `Case ${c.id}`;
    link.addEventListener("click", () => run(() => showCase(c.id)));
    cell(row, "").append(link);
    cell(row, c.status).className = `status-${c.status}`;
    cell(row, c.decided_by ?? "");
    cell(row, c.domain ?? "(no URL)");
    cell(row, String(c.sightings));
    cell(row, String(c.independent_devices));
    cell(row, yesNo(c.drain_pattern));
    cell(row, yesNo(c.domain_listed));
    cell(row, time(c.updated_at));
    body.append(row);
  }
  if (cases.length === 0) cell(body.insertRow(), "No cases yet.").colSpan = 9;
  $("case-section").hidden = true;
  $("cases-section").hidden = false;
  say(`${cases.length} case${cases.length === 1 ? "" : "s"}.`);
}

function field(list, name, value) {
  const dt = document.createElement("dt");
  dt.textContent = name;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

function resimulationText(r) {
  if (r === null) return "not run";
  const match = r.matches
    ? "reproduced the stored summary"
    : "did not reproduce the stored summary";
  return `${match}; drain pattern ${yesNo(r.drain_pattern)} (at ${time(r.at)})`;
}

async function showCase(id) {
  const { case: c, evidence } = await api(`/cases/${id}`);
  currentCase = c.id;
  $("case-title").textContent = `Case ${c.id}`;
  $("case-status").textContent =
    `Status: ${c.status}${c.decided_by ? ` (by ${c.decided_by})` : ""}. ` +
    `Domain: ${c.domain ?? "(no URL)"}. Sightings: ${c.sightings} from ${c.independent_devices} ` +
    `device${c.independent_devices === 1 ? "" : "s"}. Drain pattern: ${yesNo(c.drain_pattern)}. ` +
    `Listed domain: ${yesNo(c.domain_listed)}.`;
  $("escalate").disabled = c.status === "escalated";
  $("dismiss").disabled = c.status === "dismissed";
  const list = $("evidence");
  list.replaceChildren();
  for (const e of evidence) {
    const item = document.createElement("li");
    const dl = document.createElement("dl");
    field(dl, "Sighting", `${e.sighting_id}, received ${time(e.received_at)}`);
    field(dl, "Device hash", e.device_hash);
    field(dl, "QR payload", e.payload);
    field(dl, "URL", e.url ?? "(none)");
    field(dl, "Program IDs", e.program_ids.join(", ") || "(none)");
    field(dl, "Recipients", e.recipients.join(", ") || "(none)");
    field(dl, "Summary", JSON.stringify(e.summary, null, 2));
    field(
      dl,
      "App simulation",
      e.simulation
        ? `slot ${e.simulation.slot}, blockhash ${e.simulation.blockhash}`
        : "(none)",
    );
    field(dl, "Re-simulation", resimulationText(e.resimulation));
    field(dl, "Transaction (base64)", e.transaction ?? "(none)");
    field(dl, "Reported", `${time(e.reported_at)}, app ${e.app_version}`);
    field(dl, "Wallet", e.wallet ?? "(left out)");
    item.append(dl);
    list.append(item);
  }
  $("cases-section").hidden = true;
  $("case-section").hidden = false;
  say("");
}

async function decide(action) {
  if (currentCase === null) return;
  const { outcome, case: c } = await api(
    `/cases/${currentCase}/${action}`,
    "POST",
  );
  await showCase(c.id);
  say(
    outcome === "decided"
      ? `Case ${c.id} is now ${c.status}.`
      : `Case ${c.id} was already ${c.status}.`,
  );
}

async function run(task) {
  try {
    await task();
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("token-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      sessionStorage.setItem(TOKEN_KEY, $("token").value);
    } catch {
      say(
        "This browser does not allow tab storage, so the token cannot be kept.",
      );
      return;
    }
    $("token").value = "";
    run(showCases);
  });
  $("refresh").addEventListener("click", () => run(showCases));
  $("back").addEventListener("click", () => run(showCases));
  $("escalate").addEventListener("click", () => run(() => decide("escalate")));
  $("dismiss").addEventListener("click", () => run(() => decide("dismiss")));
  if (token() !== "") run(showCases);
});
