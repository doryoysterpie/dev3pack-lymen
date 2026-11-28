# apps/station

The Vite page for the station display (D-02). It shows the signed station QR from E-03, and fetches a fresh one 30 s after the request for the last one left, or sooner at that QR's deadline. The caption under the QR names the station and session signed into the QR, then says "A new QR every 30 s." For a QR signed for less than 60 s, because its session ends first, it says "This QR expires by the session's end." instead. It is a statement, not a countdown: it does not change while a QR is shown. A QR signed for another station than the page's is refused, not drawn.

## Run

Start the API first (see `services/api/README.md`), with `STATION_DISPLAY_TOKEN` set and a station and session seeded. Then:

```bash
npm run dev -w @limen/station
```

Copy the station's display token with `npm run station-token -w @limen/api -- st-front`, on macOS (see `services/api/README.md`). Then open `http://127.0.0.1:5173/?station=st-front` and paste the token into the page's password field. Each station's token is its own, not `STATION_DISPLAY_TOKEN`, and the API refuses it any other station's QR. The page sends its requests to `/api`, and the Vite dev and preview servers forward them to the API at `http://127.0.0.1:8787`, or at `STATION_API_URL` if set.

The page keeps the token in memory and sends it in the `Authorization` header of its requests. It does not put it in the address, the history, a cookie or storage (`src/page.test.ts`). So a reload asks for it again, whether by hand or the one the Vite dev server makes when a source file changes. An earlier version delivered the token in a link file and the address fragment; that is removed. Two copies remain outside the page:

- **The clipboard,** until something else is copied over it.
- **The browser's password manager,** if the browser offers to save the field and the offer is accepted. Decline it.

If a fetch fails, or gets no answer within 10 s, the page clears the QR, shows the reason, and tries again after 5 s. Every time the page acts on comes from the QR's signed `issued_at` and `expires_at`, read against the page's own clock, and none from the answer's other fields. That assumes the station's clock agrees with the API's within the verifier's 5 s skew; the page does not check it. A QR's deadline is `min(expires_at * 1000, sentAt + (expires_at - issued_at) * 1000)` ms, where `sentAt` is when the request left. A QR whose deadline has passed when it arrives is not drawn, and the next one is fetched at once. After drawing a QR, the page reads its clock again. It shows the QR only if the deadline is still ahead, and clears it at the deadline, when the page says it is refreshing.

What the servers serve (`vite.config.ts`):

- **The dev server.** In this folder it serves `index.html`, the `.ts` and `.css` files under `src`, and Vite's dependency cache, where `qrcode` is bundled. Any other file here gets 403, by its path or by `/@fs/`, a key named `organizer.json` in `src` included.
- **The preview server.** It answers `/` and paths ending `.html`, `.js`, `.css` or `.svg`, and 403 to any other path outside `/api`.
- **Both.** They refuse, by name, key and certificate files, keypair files, databases, `.env` files and the `node_modules/@limen` workspace links, except under `/api`, which they forward to the API, so a station named `keys` still works. They send no CORS header.
- **The build.** It copies no public folder, and it fails when its output holds anything but the page's `.html`, `.js`, `.css` and `.svg` files.

The API also refuses to start with an organizer key file inside this folder (see `services/api/README.md`).

## Test

```bash
npm test -w @limen/station
```

`src/dev-server.test.ts` starts the dev server with this app's `vite.config.ts`. It puts uniquely named stand-ins for a key file in `keys/`, keypair files, databases and a plain repository file where the repository keeps such files, and checks that each gets 403 or 404. The requests use the `/@fs/` path, `?raw` or `?import&raw`, the `node_modules/@limen/api` workspace link, and the station folder's own path. It also checks that the preview server, after a build to a temporary folder, refuses a station keypair by its name and by `/@fs/` and a database through the workspace link; that neither server sends a CORS header with the page; and that the dev server still serves the page module and the preview server the page. Three more tests owe:

- 403 from both servers for a stand-in key named `organizer.json` in `build/`, and 403 from the dev server for this folder's `vite.config.ts`, `package.json` and `README.md`, while the page and every module it loads answer 200;
- that a station named `keys` reaches a stand-in API through both servers' proxy;
- that a build whose output holds an extra `organizer.json` fails.

`src/page.test.ts` loads the page itself, `src/main.ts`, with a stand-in document and window. It checks:

- the page asks for the token in a password field with autocomplete off, in no form, and fetches nothing until it is given;
- the token goes in the `Authorization` header and nowhere else: not the address, the history, a cookie or storage;
- a reload asks for the token again;
- an address with no valid station shows the station error and asks for no token;
- another station's genuine QR is refused rather than drawn;
- the caption comes from the signed fields, whatever the answer's other fields say, and states the interval rather than counting down;
- a QR whose deadline passes while it is drawn is not shown;
- a genuine full-length QR issued 2 minutes ago is not shown;
- a QR whose draw ends 100 ms before its deadline is shown, and cleared at the deadline.

Against the real API, with every answer delayed 2 s, it checks that a QR past its deadline on arrival is not drawn, and that the next session's QR is fetched on arrival and refreshed 30 s after its request left.

`src/rotation.test.ts` drives the rotation with a fake clock. It checks:

- the page fetches and shows a QR at 0 s, 30 s and 60 s and not before;
- a failed fetch clears the QR and retries after 5 s;
- a fetch with no answer is abandoned at 10 s and retried;
- a QR's deadline comes from its signed times and from when its request left, with and without a 2 s delay, and the next fetch comes at it when that is sooner than 30 s;
- a genuine full-length QR issued 2 minutes ago is not drawn;
- the deadline and the next fetch come from the signed times when the answer's other fields disagree, and a QR past its deadline on arrival is not drawn;
- each API failure becomes the owed message;
- a station's display token, as the station-token tool derives it, reaches the real API and gets that station's QR, while the secret itself is refused.

It does not draw a QR; drawing was checked by hand in a browser at an earlier head (see the E-03 pull request).
