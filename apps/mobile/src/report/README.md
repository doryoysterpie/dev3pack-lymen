# apps/mobile/src/report

The app side of reporting (E-10). Draft: whether E-10 covers the app half is a scope ruling held for the owner.

After the pre-flight card for a Solana Pay transaction request, the user can press **Decline**. The sign button goes away, and the app offers **Report this QR**. The report is the evidence bundle the API's `POST /reports` takes (`services/api/src/evidence.ts` on E-10): the QR text, the request's link, the transaction as fetched, the summary the card was built from, the programs the transaction calls, the addresses it would send value or control to, the time, the app version and a device ID. The user's wallet address goes in only when the user turns on **Include my wallet address**. The transaction bytes still name the wallet as an account key, because the server needs them whole to re-simulate, and the panel says so.

| File              | What it does                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bundle.ts`       | Builds the bundle from a ready pre-flight, a pure module. The summary is cut to the form the E-09 fixtures owe: each instruction the wallet does not authorize becomes its index and kind. |
| `client.ts`       | POSTs the bundle to `<EXPO_PUBLIC_API_URL>/reports` and reads the case the server put it in.                                                                                               |
| `config.ts`       | Reads `EXPO_PUBLIC_API_URL`. Unset, the panel says the build has no report server and sends nothing.                                                                                       |
| `device-id.ts`    | The install ID sent as `device_id`: random, made once, and kept with `expo-secure-store`, the only thing the app stores with it. If the store fails, the ID lasts that launch only.        |
| `ReportPanel.tsx` | The Decline and Report actions under the card.                                                                                                                                             |

## Run

Set `EXPO_PUBLIC_API_URL` in the shell that runs the app. On the Android emulator the API on the host at `127.0.0.1:8787` is `http://10.0.2.2:8787`.

## Test

```bash
npm test -w @limen/mobile
```

`bundle.test.ts` owes the exact bundle JSON for the E-09 fixture drainer, and checks that the wallet's address appears nowhere in it unless the user opts in. `client.test.ts` owes the exact request (URL, method, header, body) and the answer read from each server response. `device-id.test.ts` checks the ID's format.

## Not checked yet

- No device or emulator run: the panel has been type-checked, not seen on a screen.
- Under D-05, "independent devices" means distinct install IDs, not distinct phones or people: a reinstall or a second emulator is a new ID.
- `expo-secure-store` has not run on a device; the tests use an in-memory store.
- The bundle's `simulation` is null, because the pre-flight does not keep the simulation's slot and blockhash.
- Whether the server's re-simulation reproduces this summary depends on the server running the pre-flight with the same wallet; with the wallet left out it cannot, as things stand.
- Android may refuse plain `http` to the emulator host outside a development build.
