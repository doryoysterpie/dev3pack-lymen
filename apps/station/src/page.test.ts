// E-03: the station page itself (main.ts), run in Node with a stand-in document, window and
// clock. Each run imports main.ts afresh, so it starts as a page load does.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { test } from "node:test";

import { issueStationQr } from "../../../services/api/src/station-qr.ts";

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const SIGNER = {
  publicKey: Buffer.from(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
  privateKey: createPrivateKey({
    key: Buffer.from(
      "302e020100300506032b657004220420" +
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  }),
};
const T = 1_795_000_000;

/** A genuine signed QR for `station`, as the API's issuer makes it. */
const signedQr = (station: string) =>
  issueStationQr({ station, session: "day-2", now: T, signer: SIGNER }).text;

/** A fetch that answers every request with `body` as JSON, status 200. */
const answering = (body: unknown) => (): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

/** A fake clock: timers run only when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    get now() {
      return now;
    },
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

type Clock = ReturnType<typeof fakeClock>;

/** One page element: records each text it is given, in order, in the shared log. */
function element(id: string, log: string[]) {
  const ctx = {
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
    clearRect: () => {},
    putImageData: () => {},
  };
  let text = "";
  return {
    id,
    hidden: true,
    dataset: {} as Record<string, string>,
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
    get textContent() {
      return text;
    },
    set textContent(value: string) {
      text = value;
      log.push(`${id}: ${value}`);
    },
  };
}

let runs = 0;

/**
 * Loads main.ts at `href`. `fetchFn` answers the page's requests; it may wait on `clock`. Returns
 * the page's elements, the shared log of what the page did, and the clock.
 */
async function loadPage(
  href: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  clock: Clock = fakeClock(),
) {
  const log: string[] = [];
  const elements = {
    qr: element("qr", log),
    caption: element("caption", log),
    problem: element("problem", log),
  };
  const g = globalThis as Record<string, unknown>;
  g.document = {
    getElementById: (id: string) =>
      (elements as Record<string, unknown>)[id] ?? null,
  };
  g.window = {
    location: { href },
    history: {
      replaceState: (_state: unknown, _title: string, url: URL | string) =>
        log.push(`address: ${String(url)}`),
    },
    fetch: (url: string, init?: RequestInit) => {
      log.push(`fetch: ${url}`);
      return fetchFn(url, init);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    performance: { now: () => clock.now },
  };
  await import(new URL(`./main.ts?run=${++runs}`, import.meta.url).href);
  await flush();
  return { elements, log, clock };
}

const never = (): Promise<Response> => new Promise(() => {});

test("the token leaves the address bar before a station error is shown", async () => {
  for (const href of [
    "http://127.0.0.1:5173/#token=station-token-0123456789",
    "http://127.0.0.1:5173/?station=bad%20id#token=station-token-0123456789",
  ]) {
    const { log } = await loadPage(href, never);
    const address = log.findIndex((l) => l.startsWith("address: "));
    const problem = log.findIndex((l) => l.startsWith("problem: "));
    assert.ok(address !== -1, `${href}: the address is rewritten`);
    assert.ok(!log[address]!.includes("#"), `${href}: the fragment is gone`);
    assert.ok(problem !== -1 && address < problem, `${href}: before the error`);
  }
});

test("a valid address also loses its token before the first fetch", async () => {
  const { log } = await loadPage(
    "http://127.0.0.1:5173/?station=st-front#token=station-token-0123456789",
    never,
  );
  assert.equal(log[0], "address: http://127.0.0.1:5173/?station=st-front");
  assert.equal(log[1], "fetch: /api/stations/st-front/qr");
});

test("a response carrying another station's genuine QR is refused, not drawn under this station's name", async () => {
  // As in the audit: st-side's genuine QR, labelled st-front by the response.
  const { elements, log } = await loadPage(
    "http://127.0.0.1:5173/?station=st-front#token=station-token-0123456789",
    answering({
      qr: signedQr("st-side"),
      station: "st-front",
      session: "day-2",
      issued_at: T,
      expires_at: T + 60,
      refresh_after_s: 30,
      expires_in_ms: 60_000,
    }),
  );
  assert.equal(elements.qr.dataset.qr, undefined, "no QR is drawn");
  assert.ok(log.includes("problem: The API sent a QR for another station."));
  assert.ok(!log.some((l) => l.startsWith("caption: Station")));
});

test("the caption comes from the signed QR and states the server's interval", async () => {
  // The response's own fields disagree with the QR; only the QR's signed payload counts.
  const qr = signedQr("st-front");
  const { elements } = await loadPage(
    "http://127.0.0.1:5173/?station=st-front#token=station-token-0123456789",
    answering({
      qr,
      station: "st-other",
      session: "day-9",
      issued_at: T,
      expires_at: T + 60,
      refresh_after_s: 7,
      expires_in_ms: 60_000,
    }),
  );
  assert.equal(elements.qr.dataset.qr, qr);
  assert.equal(
    elements.caption.textContent,
    "Station st-front, session day-2. Next QR in 7 s.",
  );
});
