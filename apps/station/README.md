# apps/station

The Vite page for the station display (D-02). It shows the signed station QR from E-03 and replaces it every 30 s.

## Run

Start the API first (see `services/api/README.md`), with `STATION_DISPLAY_TOKEN` set and a station and session seeded. Then:

```bash
npm run dev -w @limen/station
```

Open `http://127.0.0.1:5173/?station=st-front#token=<STATION_DISPLAY_TOKEN>`. The page forwards `/api` requests to the API at `http://127.0.0.1:8787`, or at `STATION_API_URL` if set. The token sits in the address fragment, which the browser does not send to any server, and the page removes it from the address bar once read.

If a fetch fails, the page clears the QR, shows the reason, and tries again after 5 s.

## Test

```bash
npm test -w @limen/station
```

`src/rotation.test.ts` drives the rotation with a fake clock: it checks that the page fetches and shows a QR at 0 s, 30 s and 60 s and not before, that a failed fetch clears the QR and retries after 5 s, and that each API failure becomes the owed message. It does not draw a QR; drawing was checked by hand in a browser (see the E-03 pull request).
