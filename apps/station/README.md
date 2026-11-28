# apps/station

The Vite page for the station display (D-02). It shows the signed station QR from E-03 and replaces it when the API says, every 30 s or sooner near a session's end. The caption under the QR names the station and session signed into the QR, then says "A new QR every 30 s.", or, when the API asks for a refresh in under 30 s because the QR expires at its session's end, "This QR lasts until the session ends." It is a statement, not a countdown, since it does not change while a QR is shown. A QR signed for another station than the page's is refused, not drawn.

## Run

Start the API first (see `services/api/README.md`), with `STATION_DISPLAY_TOKEN` set and a station and session seeded. Then:

```bash
npm run dev -w @limen/station
```

Write the station's address with `npm run station-link -w @limen/api -- st-front`, which writes it to `~/limen-station-links/st-front.url` (see `services/api/README.md`), then open the address in that file: `http://127.0.0.1:5173/?station=st-front#token=<st-front's display token>`. Each station's page holds its own station's token, never `STATION_DISPLAY_TOKEN` itself, and the API refuses it any other station's QR. The page sends its requests to `/api`, and the Vite dev and preview servers forward them to the API at `http://127.0.0.1:8787`, or at `STATION_API_URL` if set. The token sits in the address fragment, which the browser does not send to any server, and the page removes it from the address bar and the current history entry before it reads its configuration or shows anything, an error page included. Three copies of it remain:

- **The link file.** The link tool writes it into `~/limen-station-links`, readable by its owner only.
- **Whatever opened the link.** For example, the clipboard it was pasted from, or the arguments of the `open` command that opened it.
- **The browser.** Whatever it may keep of the address as it was opened, such as its history, which the page cannot reach.

A reload loses the token, because the page has already removed it from the address. That covers reloading the page by hand and the full reload the Vite dev server makes when a source file changes. The display then shows "Add #token=<display token> to the page address." To bring it back, open the address in the link file again.

If a fetch fails, or gets no answer within 10 s, the page clears the QR, shows the reason, and tries again after 5 s. The page times each request and counts the whole round trip off the time the QR had left as it left the API, `expires_in_ms`. A QR with no time left when it arrives is never drawn, and the next one is fetched at once. A shown QR is cleared, and the page says it is refreshing, when that time runs out, and the next fetch comes at the API's refresh point, counted the same way.

## Test

```bash
npm test -w @limen/station
```

`src/dev-server.test.ts` starts the dev server with this app's `vite.config.ts`, puts a link file in the repository's `.station-links/` folder, and checks that requests for it by `/@fs/` path, with `?raw` or with `?import&raw`, and from another localhost origin, get 403 or 404 and never the file. A second test puts stand-ins for a key file in `keys/`, a `*.keypair.json` and a plain file at the repository root, and a database file in `services/api/`, and checks that each gets 403 or 404 the same ways, while the page and its script still load.

`src/page.test.ts` loads the page itself, `src/main.ts`, with a stand-in document and window, and checks that the token leaves the address bar before a station error or the first fetch, that another station's genuine QR is refused rather than drawn, and that the caption comes from the signed QR and states the interval rather than counting down. Against the real API with every answer delayed 2 s, it checks that a QR that expires in transit is never drawn and that the next session's QR is fetched on arrival and refreshed at the API's refresh point. `src/rotation.test.ts` drives the rotation with a fake clock: it checks that the page fetches and shows a QR at 0 s, 30 s and 60 s and not before, that a failed fetch clears the QR and retries after 5 s, that a fetch with no answer is abandoned at 10 s and retried, that an outlived QR gives way to the refreshing state, that each API failure becomes the owed message, and that a link from the link tool reaches the real API and gets that station's QR while the secret itself is refused. It does not draw a QR; drawing was checked by hand in a browser (see the E-03 pull request).
