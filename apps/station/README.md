# apps/station

The Vite page for the station display (D-02). It shows the station QR the API signs (E-03), with a caption naming the station and session signed into it, and refuses a QR signed for another station.

## Run

Start the API (see `services/api/README.md`) with `STATION_DISPLAY_TOKEN` set and a station and session seeded, then:

```bash
npm run dev -w @limen/station
```

On macOS, copy the station's display token with `npm run station-token -w @limen/api -- st-front`, open `http://127.0.0.1:5173/?station=st-front`, and paste the token into the password field. The dev and preview servers forward `/api` to the API at `STATION_API_URL`, or `http://127.0.0.1:8787`.

The page keeps the token in memory and sends it in the `Authorization` header. It puts it in no address, history entry, cookie or storage, so a reload asks again (`src/page.test.ts`). The token stays on the clipboard until something else is copied over it, and a browser may offer to save the field; decline it.

**Upgrading from link files.** An earlier version wrote each station's address, token included, to link files in `~/limen-station-links` or `.station-links/`. Delete any, and set a new `STATION_DISPLAY_TOKEN`, from which every station's token derives. The page drops any fragment from its address on load without reading it, and `.gitignore` still ignores `*.url` files and `.station-links/`.

## Timing

The page times each QR on its own clock against the signed `issued_at` and `expires_at`. It assumes the station's clock agrees with the API's within the verifier's 5 s skew, and does not check it, so it stops 5 s early: the deadline is `min(expires_at * 1000, sentAt + (expires_at - issued_at) * 1000) - 5000` ms, where `sentAt` is when the request left. A QR past its deadline on arrival is not drawn. After drawing a QR, the page reads its clock again, shows the QR only with time left, and arms a timer for that time to clear it; a busy browser may run the timer late. The next fetch comes 30 s after the request left, or at the deadline if sooner, timed from the clock after the draw. A failed fetch, or one with no answer in 10 s, shows why and is retried after 5 s.

## What the servers serve

See `vite.config.ts` and `src/dev-server.test.ts`.

- **Dev:** in this folder, `index.html`, the `.ts`, `.css` and `.svg` files under `src`, and Vite's dependency cache. Any other file here gets 403.
- **Preview:** `/` and the files Vite's manifest names. Any other path outside `/api` gets 403.
- **Both:** 403 by name, outside `/api`, for key and certificate files, keypair files, databases, `.env` files and the `node_modules/@limen` links, and no CORS header.
- **Build:** no public folder, and a failure when the output holds a file Vite's manifest does not name.

The API refuses to start with an organizer key inside this folder (see `services/api/README.md`).

## Test

```bash
npm test -w @limen/station
```

`src/dev-server.test.ts` covers the servers and the build. `src/page.test.ts` covers the page, with a stand-in document and window, and against the real API with every answer delayed 2 s. `src/rotation.test.ts` covers the rotation with a fake clock. No test draws a QR and decodes it.
