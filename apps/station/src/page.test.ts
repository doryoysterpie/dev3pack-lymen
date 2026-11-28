// E-03: the station page itself (main.ts), run in Node with a stand-in document, window and
// clock. Each run imports main.ts afresh, so it starts as a page load does.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { AddressInfo } from "node:net";

import { openDatabase } from "../../../services/api/src/db.ts";
import {
  API_VERSION,
  createApiServer,
} from "../../../services/api/src/server.ts";
import { issueStationQr } from "../../../services/api/src/station-qr.ts";
import { stationDisplayToken } from "../../../services/api/src/station-token.ts";

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

/** A fake clock: its timers run when the test advances time. */
function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  /** The delay each timer was armed with, in order. */
  const delays: number[] = [];
  return {
    delays,
    get now() {
      return now;
    },
    setTimeout: (fn: () => void, ms: number): number => {
      delays.push(ms);
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    /** Moves the clock forward without running any timer, as a slow step on the page would. */
    jump(ms: number): void {
      now += ms;
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        // A jump during a step is not undone: the clock does not move back.
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = Math.max(now, end);
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

/** The token field and its button: a value, and the listeners the page adds. */
function control(id: string) {
  const listeners = new Map<string, ((event: { key?: string }) => void)[]>();
  return {
    id,
    hidden: true,
    value: "",
    addEventListener(type: string, fn: (event: { key?: string }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    fire(type: string, event: { key?: string } = {}) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

/**
 * Stand-ins for both storages and cookies, which keep what is written so a reload can find it.
 * The writes made through them, and through the address and history stand-ins in loadPage, are
 * recorded; a write by any other route is not.
 */
function keeper() {
  const writes: string[] = [];
  const storage = (name: string) => {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(`${name}.setItem(${key}, ${value})`);
        items.set(key, value);
      },
      removeItem: (key: string) => {
        writes.push(`${name}.removeItem(${key})`);
        items.delete(key);
      },
      clear: () => {
        writes.push(`${name}.clear()`);
        items.clear();
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      get length() {
        return items.size;
      },
    };
  };
  let cookie = "";
  return {
    writes,
    localStorage: storage("localStorage"),
    sessionStorage: storage("sessionStorage"),
    getCookie: () => cookie,
    setCookie: (value: string) => {
      writes.push(`document.cookie = ${value}`);
      cookie = value;
    },
  };
}
type Keeper = ReturnType<typeof keeper>;

let runs = 0;

const INDEX_HTML = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const STATION_URL = "http://127.0.0.1:8787/station?station=st-front";
const TOKEN = "station-token-0123456789";

/**
 * Loads main.ts afresh at `href`. `fetchFn` answers its requests. With `token`, the token is typed
 * into the field and the button pressed.
 */
async function loadPage(
  href: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  clock: Clock = fakeClock(),
  options: { token?: string; keep?: Keeper } = {},
) {
  const log: string[] = [];
  const sent: string[] = [];
  const keep = options.keep ?? keeper();
  const elements = {
    qr: element("qr", log),
    caption: element("caption", log),
    problem: element("problem", log),
    "token-prompt": control("token-prompt"),
    token: control("token"),
    "token-start": control("token-start"),
  };
  let address = href;
  const record = (what: string) => (value: unknown) => {
    keep.writes.push(`${what}(${String(value)})`);
    address = String(value);
  };
  // The parts of the address the page may read, and a record of any read of the rest.
  const reads: string[] = [];
  const url = new URL(href);
  const location = {
    pathname: url.pathname,
    search: url.search,
    get href() {
      reads.push("href");
      return address;
    },
    set href(value: string) {
      record("location.href =")(value);
    },
    get hash() {
      reads.push("hash");
      return new URL(address, url).hash;
    },
    assign: record("location.assign"),
    replace: record("location.replace"),
  };
  const g = globalThis as Record<string, unknown>;
  g.document = {
    getElementById: (id: string) =>
      (elements as Record<string, unknown>)[id] ?? null,
    get cookie() {
      return keep.getCookie();
    },
    set cookie(value: string) {
      keep.setCookie(value);
    },
  };
  g.window = {
    location,
    history: {
      replaceState: (_s: unknown, _t: string, url: URL | string) =>
        record("history.replaceState")(url),
      pushState: (_s: unknown, _t: string, url: URL | string) =>
        record("history.pushState")(url),
    },
    localStorage: keep.localStorage,
    sessionStorage: keep.sessionStorage,
    fetch: (url: string, init?: RequestInit) => {
      log.push(`fetch: ${url}`);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push(headers.authorization ?? "");
      return fetchFn(url, init);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // The page's clock.
    Date: { now: () => clock.now },
  };
  await import(new URL(`./main.ts?run=${++runs}`, import.meta.url).href);
  await flush();
  if (options.token !== undefined) {
    elements.token.value = options.token;
    elements["token-start"].fire("click");
    await flush();
  }
  return {
    elements,
    log,
    sent,
    writes: keep.writes,
    clock,
    address: () => address,
    reads,
  };
}

const never = (): Promise<Response> => new Promise(() => {});

test("the page asks for the token in a password field with autocomplete off, in no form, and fetches nothing until it is given", async () => {
  const input = /<input\b[^>]*\bid="token"[^>]*>/.exec(INDEX_HTML)?.[0] ?? "";
  assert.match(input, /\btype="password"/);
  assert.match(input, /\bautocomplete="off"/);
  assert.equal(/<form\b/i.test(INDEX_HTML), false, "no form to submit");
  for (const press of [
    (page: Awaited<ReturnType<typeof loadPage>>) =>
      page.elements["token-start"].fire("click"),
    (page: Awaited<ReturnType<typeof loadPage>>) =>
      page.elements.token.fire("keydown", { key: "Enter" }),
  ]) {
    const page = await loadPage(STATION_URL, never);
    assert.equal(page.elements["token-prompt"].hidden, false);
    assert.ok(!page.log.some((l) => l.startsWith("fetch: ")));
    // An empty field starts nothing.
    press(page);
    await flush();
    assert.deepEqual(page.sent, []);
    page.elements.token.value = TOKEN;
    press(page);
    await flush();
    assert.equal(page.elements.token.value, "", "the field is cleared");
    assert.equal(page.elements["token-prompt"].hidden, true);
    assert.deepEqual(page.sent, [`Bearer ${TOKEN}`]);
  }
});

test("the token goes in the Authorization header and nowhere else: not the address, the history, a cookie or storage", async () => {
  const clock = fakeClock();
  const page = await loadPage(
    STATION_URL,
    answering({ qr: signedQr("st-front") }),
    clock,
    { token: TOKEN },
  );
  await clock.advance(30_000);
  assert.deepEqual(page.sent, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  // The one write is the address without a fragment, made at load.
  assert.deepEqual(page.writes, [
    "history.replaceState(/station?station=st-front)",
  ]);
  assert.ok(!page.writes.some((w) => w.includes(TOKEN)));
  assert.ok(!page.log.some((l) => l.includes(TOKEN)));
});

test("a reload asks for the token again: the page keeps nothing that lets it start without one", async () => {
  const keep = keeper();
  const first = await loadPage(
    STATION_URL,
    answering({ qr: signedQr("st-front") }),
    fakeClock(),
    { token: TOKEN, keep },
  );
  assert.deepEqual(first.sent, [`Bearer ${TOKEN}`]);
  // The same storages and cookies, as after a reload.
  const second = await loadPage(
    STATION_URL,
    answering({ qr: signedQr("st-front") }),
    fakeClock(),
    { keep },
  );
  assert.equal(second.elements["token-prompt"].hidden, false);
  assert.ok(!second.log.some((l) => l.startsWith("fetch: ")));
});

test("a fragment left by an earlier version's link is cleared from the address, and never read", async () => {
  const page = await loadPage(
    "http://127.0.0.1:8787/station?station=st-front#token=old-link-token",
    never,
  );
  assert.deepEqual(page.writes, [
    "history.replaceState(/station?station=st-front)",
  ]);
  assert.ok(!page.address().includes("#"));
  assert.deepEqual(page.reads, [], "neither href nor hash was read");
  assert.equal(page.elements["token-prompt"].hidden, false);
  assert.ok(!page.log.some((l) => l.includes("old-link-token")));
});

test("an address with no valid station shows the station error and asks for no token", async () => {
  for (const href of [
    "http://127.0.0.1:8787/station",
    "http://127.0.0.1:8787/station?station=bad%20id",
  ]) {
    const page = await loadPage(href, never);
    assert.ok(
      page.log.includes(
        "problem: Add ?station=<station ID> to the page address.",
      ),
      href,
    );
    assert.equal(page.elements["token-prompt"].hidden, true, href);
  }
});

test("a response carrying another station's genuine QR is refused, not drawn under this station's name", async () => {
  // st-side's genuine QR, labelled st-front by the response.
  const { elements, log } = await loadPage(
    STATION_URL,
    answering({
      qr: signedQr("st-side"),
      station: "st-front",
      session: "day-2",
      issued_at: T,
      expires_at: T + 60,
      refresh_after_s: 30,
      expires_in_ms: 60_000,
    }),
    fakeClock(),
    { token: TOKEN },
  );
  assert.equal(elements.qr.dataset.qr, undefined, "no QR is drawn");
  assert.ok(log.includes("problem: The API sent a QR for another station."));
  assert.ok(!log.some((l) => l.startsWith("caption: Station")));
});

test("the caption comes from the signed QR's fields, whatever the answer's other fields say, and states the interval, not a countdown", async () => {
  const href = STATION_URL;
  // A full 60 s QR, while the answer's own fields name another station, another session and a
  // 7 s refresh; the caption follows the signed fields.
  const full = signedQr("st-front");
  const first = await loadPage(
    href,
    answering({
      qr: full,
      station: "st-other",
      session: "day-9",
      issued_at: T,
      expires_at: T + 20,
      refresh_after_s: 7,
      expires_in_ms: 20_000,
    }),
    fakeClock(),
    { token: TOKEN },
  );
  assert.equal(first.elements.qr.dataset.qr, full);
  assert.equal(
    first.elements.caption.textContent,
    "Station st-front, session day-2. A new QR every 30 s.",
  );
  // A QR the API cut to 20 s by its session's end says so, though the answer claims 60 s.
  const cut = issueStationQr({
    station: "st-front",
    session: "day-2",
    now: T,
    signer: SIGNER,
    notAfter: T + 20,
  }).text;
  const second = await loadPage(
    href,
    answering({
      qr: cut,
      station: "st-front",
      session: "day-2",
      issued_at: T,
      expires_at: T + 60,
      refresh_after_s: 30,
      expires_in_ms: 60_000,
    }),
    fakeClock(),
    { token: TOKEN },
  );
  assert.equal(
    second.elements.caption.textContent,
    "Station st-front, session day-2. This QR expires by the session's end.",
  );
});

test("a QR whose deadline passes while it is being drawn is not revealed", async () => {
  const clock = fakeClock();
  const qr = signedQr("st-front");
  const slow = (): Promise<Response> =>
    new Promise((resolve) => {
      clock.setTimeout(
        () =>
          resolve(
            new Response(JSON.stringify({ qr }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        100,
      );
    });
  const { elements, log } = await loadPage(STATION_URL, slow, clock, {
    token: TOKEN,
  });
  // The draw takes until past the deadline.
  const ctx = elements.qr.getContext();
  elements.qr.getContext = () => {
    clock.jump(60_000);
    return ctx;
  };
  await clock.advance(100);
  assert.equal(elements.qr.hidden, true, "the canvas stays hidden");
  assert.equal(elements.qr.dataset.qr, undefined);
  assert.ok(!log.some((l) => l.startsWith("caption: Station")));
  assert.equal(elements.caption.textContent, "Refreshing the QR. Please wait.");
});

test("a genuine full-length QR issued 2 minutes ago is not shown", async () => {
  // The page's clock reads T; the API signed this QR at T - 120 s for its full 60 s.
  const old = issueStationQr({
    station: "st-front",
    session: "day-2",
    now: T - 120,
    signer: SIGNER,
  }).text;
  const { elements, log } = await loadPage(
    STATION_URL,
    answering({ qr: old }),
    fakeClock(T * 1000),
    { token: TOKEN },
  );
  assert.equal(elements.qr.dataset.qr, undefined, "no QR is drawn");
  assert.equal(elements.qr.hidden, true);
  assert.ok(!log.some((l) => l.startsWith("caption: Station")));
});

test("a slow draw that ends 100 ms before the deadline shows the QR and arms its clearing timer for those 100 ms", async () => {
  const clock = fakeClock(T * 1000);
  const qr = signedQr("st-front"); // signed at T for 60 s
  // The first answer comes 100 ms after its request; later requests get no answer.
  let calls = 0;
  const once = (): Promise<Response> =>
    calls++ > 0
      ? never()
      : new Promise((resolve) => {
          clock.setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ qr }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            100,
          );
        });
  const { elements } = await loadPage(STATION_URL, once, clock, {
    token: TOKEN,
  });
  // The request left at T, so the deadline is T + 60 s - 5 s. The draw takes until 100 ms before
  // it.
  const ctx = elements.qr.getContext();
  let drawn = false;
  elements.qr.getContext = () => {
    if (!drawn) clock.jump(54_800);
    drawn = true;
    return ctx;
  };
  await clock.advance(100);
  assert.equal(clock.now, T * 1000 + 54_900);
  assert.equal(elements.qr.hidden, false, "shown with 100 ms left");
  assert.equal(elements.qr.dataset.qr, qr);
  assert.ok(
    clock.delays.includes(100),
    "the clearing timer is armed for 100 ms",
  );
  await clock.advance(99);
  assert.equal(elements.qr.hidden, false, "still shown 1 ms before");
  await clock.advance(1);
  assert.equal(elements.qr.hidden, true, "cleared at the deadline");
  assert.equal(elements.caption.textContent, "Refreshing the QR. Please wait.");
});

test("with a 2 s response delay, a QR that expires in transit is not drawn, and changeover follows the server's expiry", async () => {
  // day-1 ends at T and day-2 begins there. The API's clock runs with the page's fake clock,
  // starting 900 ms into day-1's last second, so the first QR has 100 ms left when issued.
  const clock = fakeClock();
  const apiMs = () => (T - 1) * 1000 + 900 + clock.now;
  const secret = "test-display-token-0123456789abcdef";
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO stations (id, name, created_at) VALUES ('st-front', 'Front desk', ${T});
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-1', 'Day 1', ${T - 86400}, ${T});
    INSERT INTO sessions (id, name, starts_at, ends_at) VALUES ('day-2', 'Day 2', ${T}, ${T + 86400});
  `);
  const server = createApiServer({
    db,
    version: API_VERSION,
    stationSigner: SIGNER,
    stationDisplayToken: secret,
    now: () => Math.floor(apiMs() / 1000),
    nowMs: apiMs,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The real API answers at once; the page gets each answer 2 s later on its own clock.
  const fetchedAt: number[] = [];
  const delayed = (url: string, init?: RequestInit): Promise<Response> => {
    fetchedAt.push(clock.now);
    const answer = fetch(`${api}${url.replace(/^\/api/, "")}`, init).then(
      async (r) => ({ status: r.status, body: await r.text() }),
    );
    return new Promise((resolve) => {
      clock.setTimeout(() => {
        void answer.then((a) =>
          resolve(
            new Response(a.body, {
              status: a.status,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }, 2000);
    });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const { log } = await loadPage(STATION_URL, delayed, clock, {
      token: stationDisplayToken(secret, "st-front"),
    });
    await settle();
    await clock.advance(2000);
    await settle();
    await clock.advance(5000);
    await settle();
    await clock.advance(2000);
    await settle();
    await clock.advance(30_000);
    const captions = log.filter((l) => l.startsWith("caption: Station"));
    assert.ok(
      !captions.some((c) => c.includes("session day-1")),
      `day-1's QR, expired on arrival, is not drawn: ${captions.join(" | ")}`,
    );
    assert.ok(captions.some((c) => c.includes("session day-2")));
    // day-1's QR arrives stale at 2 s, so the next fetch waits the 5 s retry delay, to 7 s.
    // day-2's refresh comes 30 s after its request left, at 37 s, not 30 s after it arrived.
    assert.deepEqual(fetchedAt, [0, 7000, 37_000]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("with the station's clock 2 s behind the API's, the page clears the QR at T + 53 s on that clock, T + 55 s on the API's", async () => {
  const clock = fakeClock(T * 1000 - 2000);
  const qr = signedQr("st-front"); // signed at T for 60 s
  let calls = 0;
  const once = (): Promise<Response> =>
    calls++ > 0
      ? never()
      : Promise.resolve(
          new Response(JSON.stringify({ qr }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
  const { elements } = await loadPage(STATION_URL, once, clock, {
    token: TOKEN,
  });
  await clock.advance(0);
  assert.equal(elements.qr.hidden, false, "shown");
  // min(T + 60 s, (T - 2 s) + 60 s) - 5 s = T + 53 s, 55 s after the request left.
  assert.ok(
    clock.delays.includes(55_000),
    "the clearing timer is armed for 55 s",
  );
  clock.jump(T * 1000 + 53_000 - 1 - clock.now);
  assert.equal(elements.qr.hidden, false, "still shown 1 ms before T + 53 s");
  await clock.advance(1);
  assert.equal(elements.qr.hidden, true, "cleared at T + 53 s");
});
