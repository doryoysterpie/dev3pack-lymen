# apps/station

The Vite page for the station display (D-02). It shows the signed station QR from E-03, and fetches a fresh one 30 s after the request for the last one left, or sooner at that QR's deadline. The caption under the QR names the station and session signed into the QR, then says "A new QR every 30 s." For a QR signed for less than 60 s, because its session ends first, it says "This QR expires by the session's end." instead. It is a statement, not a countdown: it does not change while a QR is shown. A QR signed for another station than the page's is refused, not drawn.

## Run

Start the API first (see `services/api/README.md`), with `STATION_DISPLAY_TOKEN` set and a station and session seeded. Then:

```bash
npm run dev -w @limen/station
```

Write the station's address with `npm run station-link -w @limen/api -- st-front`, which writes it to `~/limen-station-links/st-front.url` (see `services/api/README.md`), then open the address in that file: `http://127.0.0.1:5173/?station=st-front#token=<st-front's display token>`. Each station's page holds its own station's token, never `STATION_DISPLAY_TOKEN` itself, and the API refuses it any other station's QR. The page sends its requests to `/api`, and the Vite dev and preview servers forward them to the API at `http://127.0.0.1:8787`, or at `STATION_API_URL` if set. The token sits in the address fragment, which the browser does not send to any server, and an inline script in `index.html` removes it from the address bar and the current history entry. That script runs before the page module, so the token is gone even if the module fails to load. In the build it is the first element in `<head>`. In development Vite puts its client module before it, but module scripts run only after the page is parsed, so the inline script still runs first. Three copies of it remain:

- **The link file.** The link tool writes it into `~/limen-station-links`, readable by its owner only.
- **Whatever opened the link.** For example, the clipboard it was pasted from, or the arguments of the `open` command that opened it.
- **The browser.** Whatever it may keep of the address as it was opened, such as its history, which the page cannot reach.

A reload loses the token, because the page has already removed it from the address. That covers reloading the page by hand and the full reload the Vite dev server makes when a source file changes. The display then shows "Add #token=<display token> to the page address." To bring it back, open the address in the link file again.

If a fetch fails, or gets no answer within 10 s, the page clears the QR, shows the reason, and tries again after 5 s. Every time the page acts on comes from the QR's signed payload, `issued_at` and `expires_at`, and none from the answer's other fields. The API signed the QR within a second after `issued_at`, while the request was out. So on the page's clock the QR expires no earlier than its deadline, `sentAt + (expires_at - issued_at) * 1000 - 999` ms, where `sentAt` is when the request left. A QR past its deadline when it arrives is not drawn, and the next one is fetched at once. A shown QR is cleared at its deadline, and the page says it is refreshing. The deadline is checked again after the QR is drawn, just before it is shown.

What the servers serve: only this folder, plus Vite's own client and dependency cache. Both servers also refuse, by name, key and certificate files, keypair files, databases, link files, `.env` files and the `node_modules/@limen` workspace links, and send no CORS header (`vite.config.ts`). The build copies no public folder.

## Test

```bash
npm test -w @limen/station
```

`src/dev-server.test.ts` starts the dev server with this app's `vite.config.ts`. It puts uniquely named stand-ins for a link file, a key file in `keys/`, keypair files, databases and a plain repository file where the repository keeps such files, and checks that each gets 403 or 404. The requests use the `/@fs/` path, `?raw` or `?import&raw`, the `node_modules/@limen/api` workspace link, and the station folder's own path. It also checks that the preview server, after a build to a temporary folder, serves none of them, that neither server sends a CORS header, and that the page and its script still load.

`src/page.test.ts` loads the page itself, `src/main.ts`, with a stand-in document and window. It checks:

- `index.html` opens `<head>` with an inline script, which takes the address and removes the token from the address bar even when the page module never runs;
- the token leaves the address bar before a station error or the first fetch;
- another station's genuine QR is refused rather than drawn;
- the caption comes from the signed fields only and states the interval rather than counting down;
- a QR whose deadline passes while it is drawn is not shown.

Against the real API, with every answer delayed 2 s, it checks that a QR past its deadline on arrival is not drawn, and that the next session's QR is fetched on arrival and refreshed 30 s after its request left.

`src/rotation.test.ts` drives the rotation with a fake clock. It checks:

- the page fetches and shows a QR at 0 s, 30 s and 60 s and not before;
- a failed fetch clears the QR and retries after 5 s;
- a fetch with no answer is abandoned at 10 s and retried;
- a shown QR is cleared at its deadline from the signed times, with and without a 2 s delay;
- the deadline and the next fetch come from the signed times when the answer's other fields disagree, and a QR past its deadline on arrival is not drawn;
- each API failure becomes the owed message;
- a link from the link tool reaches the real API and gets that station's QR, while the secret itself is refused.

It does not draw a QR; drawing was checked by hand in a browser at an earlier head (see the E-03 pull request).
