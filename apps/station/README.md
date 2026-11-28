# apps/station

The Vite page for the station display (D-02). It shows the signed station QR from E-03 and replaces it every 30 s.

## Run

Start the API first (see `services/api/README.md`), with `STATION_DISPLAY_TOKEN` set and a station and session seeded. Then:

```bash
npm run dev -w @limen/station
```

Write the station's address with `npm run station-link -w @limen/api -- st-front ../../.station-links/st-front.url` (see `services/api/README.md`), then open the address in that file: `http://127.0.0.1:5173/?station=st-front#token=<st-front's display token>`. Each station's page holds its own station's token, never `STATION_DISPLAY_TOKEN` itself, and the API refuses it any other station's QR. The page forwards `/api` requests to the API at `http://127.0.0.1:8787`, or at `STATION_API_URL` if set. The token sits in the address fragment, which the browser does not send to any server, and the page removes it from the address bar before anything else, an error page included, so no copy of the page's address carries it.

If a fetch fails, or gets no answer within 10 s, the page clears the QR, shows the reason, and tries again after 5 s. If a QR's own lifetime runs out on screen before a new one arrives, the page clears it and says it is refreshing.

## Test

```bash
npm test -w @limen/station
```

`src/page.test.ts` loads the page itself, `src/main.ts`, with a stand-in document and window, and checks that the token leaves the address bar before a station error or the first fetch. `src/rotation.test.ts` drives the rotation with a fake clock: it checks that the page fetches and shows a QR at 0 s, 30 s and 60 s and not before, that a failed fetch clears the QR and retries after 5 s, that a fetch with no answer is abandoned at 10 s and retried, that an outlived QR gives way to the refreshing state, that each API failure becomes the owed message, and that a link from the link tool reaches the real API and gets that station's QR while the secret itself is refused. It does not draw a QR; drawing was checked by hand in a browser (see the E-03 pull request).
