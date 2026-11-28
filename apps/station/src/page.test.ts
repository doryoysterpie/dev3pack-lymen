// E-03: the station page itself (main.ts), run in Node with a stand-in document, window and
// clock. Each run imports main.ts afresh, so it starts as a page load does.
import assert from "node:assert/strict";
import { test } from "node:test";

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
