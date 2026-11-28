# apps/station

The Vite page for the station display (D-02). It shows the station QR the API signs (E-03), with a caption naming the station and session signed into it, and refuses a QR signed for another station.

## Run

Build the page once, then start the API (see `services/api/README.md`) with `STATION_DISPLAY_TOKEN` set and a station and session seeded:

```bash
npm run build -w @limen/station
```

The build writes one self-contained file, `dist/index.html`, with its script inlined and the build marker `<!-- limen:station-page:v1 -->` inserted. `build.ts` runs Vite in a child process whose environment is `PATH` and `NODE_ENV` alone, so no variable of yours, a secret or a `VITE_` one, reaches the build or its debug output (`src/build.test.ts`). The API reads that file once at start-up, checks on the opened descriptor that it is a regular file with link count 1, checks its doctype, build marker, size limit and key-scan result, and serves it at `/station`, whatever the query string, so the station's address is `http://127.0.0.1:8787/station?station=st-front` (`services/api/src/station-page.test.ts`). The page asks the API for its QR at `/api` on the same origin. To change the page, rebuild it and restart the API. No Vite server runs.

On macOS, copy the station's display token by running `node --env-file=.env services/api/src/copy-station-token.ts st-front` from the repository root (see `services/api/README.md`), open the station's address, and paste the token into the password field.

The page keeps the token in memory and sends it in the `Authorization` header. It puts it in no address, history entry, cookie or storage, so a reload asks again (`src/page.test.ts`). The token stays on the clipboard until something else is copied over it, and a browser may offer to save the field; decline it.

**Upgrading from link files.** An earlier version wrote each station's address, token included, to link files in `~/limen-station-links` or `.station-links/`. Delete any, and set a new `STATION_DISPLAY_TOKEN`, from which every station's token derives. The page drops any fragment from its address on load without reading it, and `.gitignore` still ignores `*.url` files and `.station-links/`.

## Timing

The page times each QR on its own clock against the signed `issued_at` and `expires_at`. It assumes the station's clock agrees with the API's within the verifier's 5 s skew, and does not check it, so it stops 5 s early: the deadline is `min(expires_at * 1000, sentAt + (expires_at - issued_at) * 1000) - 5000` ms, where `sentAt` is when the request left. A QR past its deadline on arrival is not drawn. Whenever a QR is not shown, stale on arrival or by the end of its draw, the next fetch waits 5 s (`src/rotation.test.ts`). After drawing a QR, the page reads its clock again, shows the QR only with time left, and arms a timer for that time to clear it; a busy browser may run the timer late. The next fetch comes 30 s after the request left, or at the deadline if sooner, timed from the clock after the draw. A failed fetch, or one with no answer in 10 s, shows why and is retried after 5 s.

## Test

```bash
npm test -w @limen/station
```

`src/build.test.ts` covers the build. `src/page.test.ts` covers the page, with a stand-in document and window, and against the real API with every answer delayed 2 s. `src/rotation.test.ts` covers the rotation with a fake clock. No test draws a QR and decodes it.
