# apps/mobile

The Expo React Native app with Mobile Wallet Adapter (D-02): the scanner, the QR pre-flight cards and the check-in flow. Built from E-04. It uses Expo SDK 58 and React Native 0.88.1, the versions in Expo's SDK 58 TypeScript template.

## What is here

| Path                                | What it does                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `App.tsx`                           | Camera screen. It asks for camera access, reads QR codes with `expo-camera`, classifies the text and shows a result card with the scanned text. |
| `src/qr/classify.ts`                | QR type detection, a pure module: station, Solana Pay transfer request, Solana Pay transaction request, http or https URL, or other.            |
| `src/qr/describe.ts`                | Result-card text for each QR class, kept in one place for the copy rules.                                                                       |
| `src/pay/transfer.ts`               | Transfer request card fields, from the classifier's parsed fields, a pure module.                                                               |
| `src/pay/recipient-lists.ts`        | Loads the organizer list and the flagged list and gives a recipient its status.                                                                 |
| `src/pay/recipient-lists.json`      | The devnet fixture lists the app bundles: the organizer key and the demo's flagged addresses.                                                   |
| `src/pay/card-text.ts`              | Transfer card text.                                                                                                                             |
| `src/result-card.ts`                | Picks the card for a scanned QR: the transfer card for a transfer request, the E-04 summary for anything else.                                  |
| `src/ui/CardView.tsx`               | Renders a card.                                                                                                                                 |
| `src/ui/TransactionRequestView.tsx` | The transaction request flow: connect the wallet, fetch, pre-flight, card, then signing.                                                        |
| `@limen/preflight`                  | The transaction decoder, the pre-flight and the drain pattern, in `packages/preflight` (audited). See its README.                               |
| `src/tx/request.ts`                 | The Solana Pay transaction request POST.                                                                                                        |
| `src/tx/card-text.ts`               | Transaction card text.                                                                                                                          |
| `src/wallet/mwa.ts`                 | Mobile Wallet Adapter connect and sign-and-send, on devnet.                                                                                     |
| `src/wallet/address.ts`             | Reads a wallet account's address.                                                                                                               |
| `src/config.ts`                     | The RPC endpoint and the identity the wallet shows.                                                                                             |

## How a QR is classified

- **Station**: the text starts with `limen:station:`. The prefix alone decides it. E-05 verifies the signature; nothing in E-04 does.
- **Solana Pay**: the URL scheme is `solana:`. As in the reference `parseURL` of the Solana Pay specification, a pathname holding `:` or `%` is a transaction request link, which must URL-decode to an absolute https URL. Any other pathname is a transfer request recipient, which must be base58 that decodes to 32 bytes. A transfer request's query is read and checked here too. Its fields are decoded with `decodeURIComponent`, the function SPEC.md links, so a `+` stays a `+` (the reference `parseURL` uses form decoding, which would read a space), and a field that is not valid percent-encoding is refused. The checks run in this order: `amount`, `spl-token`, `label`, `message` and `memo` may each appear once; the amount must be a non-negative integer or decimal with a leading 0 below 1 and no scientific notation, with at most 9 decimal places when it is SOL; `spl-token` and every `reference` must decode to 32 bytes. As in the reference `parseURL`, a `solana:` URL longer than 2048 characters is refused. A `solana:` URL that breaks any rule is "other" with the reason `malformed-solana-pay` and the problem it has. This is the one place a Solana Pay URL is parsed.
- **URL**: the URL scheme is `http:` or `https:`.
- **Other**: anything else.

URLs are parsed with `whatwg-url-minimum`, the package Expo installs as the global `URL` on the device, so the Node tests run the parser the app runs.

## Transfer request card (E-08)

For a Solana Pay transfer request the card shows the recipient, the amount, the token (SOL, or an SPL token by its mint), any references, and the label, message and memo marked as written in the QR. Those three come from whoever made the QR, so the card quotes each on one line, writes any line break, control character or Unicode bidirectional control as its code point (a line break shows as `\u{000A}`), writes a backslash as `\\` and a quotation mark as `\"` so the text cannot close its own quotes and reads back to one input, and draws them boxed and monospaced, apart from limen's own status line. `src/pay/transfer.ts` does not parse the URL: it reads the fields and the problem `src/qr/classify.ts` returns, so the transfer request rules live in one place. The one rule it adds is the SPL token decimal check, which needs the mint's decimals; the app does not look those up, so an SPL token amount shows that its decimal places were not checked.

The recipient's status comes from `src/pay/recipient-lists.json`, a devnet fixture list bundled with the app: **flagged** when the address is on its flagged list, **organizer** when it is on its organizer list, otherwise neither. A recipient on both is flagged. Flagged means only that the address is on that bundled list; the app checks no feed of real scam reports. The organizer list holds the devnet organizer public key Lane A made; the flagged list holds the fixture addresses the demo uses. `src/pay/shipped-lists.test.ts` loads that file, not test lists, owes every entry it ships, and checks the card for each.

A malformed transfer request gets a card that names its problem, from the classifier's list.

## Transaction request pre-flight (E-09)

For a Solana Pay transaction request the app connects to the wallet through Mobile Wallet Adapter on devnet, POSTs the wallet's address to the request's https link, and receives a base64 transaction. The card names the host it asked, as the Solana Pay specification asks wallets to do: the host and port the app's URL parser reads from the link (`linkHost`), so a user name before the host, as in `https://pay.example@evil.example`, is not shown as the host. Then:

1. **Decode.** The decoder lives in the shared package `@limen/preflight` (`packages/preflight`), so the server can use it too. `wire.ts` parses legacy and v0 transactions. It refuses, with a reason, what the SDK's sanitize rules refuse (a bad header, a program index of 0 or from a lookup table, an account index past the end, an empty lookup, more than 256 keys, a bad compact length), and also a signature count that differs from the required signers, a repeated key, trailing bytes and any version but legacy and 0. `decode.ts` decodes System `CreateAccount`, `Assign` (to a program other than the System Program), `Transfer`, `AdvanceNonceAccount` and `TransferWithSeed`; SPL Token `Transfer`, `TransferChecked`, `Approve`, `ApproveChecked`, `Revoke`, `SetAuthority`, `MintTo`, `MintToChecked`, `Burn`, `BurnChecked` and `CloseAccount`, and the same on Token-2022 except `Transfer`, `TransferChecked` and `CloseAccount`, whose effect depends on the mint's extensions (a transfer fee, a transfer hook, or a close of the mint itself); `InitializeAccount`, `SyncNative`, `InitializeAccount3` and `InitializeImmutableOwner` by name only; Associated Token Account `Create` and `CreateIdempotent`; Compute Budget, with the priority fee the wallet pays in SOL; and Memo. Data of any length but the exact one is not decoded, even where a program would accept it, except for Compute Budget, which is read as agave's `try_from_slice_unchecked` reads it (ignoring trailing bytes after a valid prefix) so the priority-fee display and runtime refusal check use one decoder. A token instruction counts as the wallet's only when the wallet is its authority account and signs. Each row for what a decoded instruction the wallet pays for or authorizes asks starts "Asks" and says what it asks for, never that it is accepted or what it changes (`src/tx/card-text.test.ts`, "re-audit 2, item 5"). Token amounts are shown as the instruction carries them, in base units, with the decimals a checked instruction states; the card works out no token quantity, since a Token-2022 mint's extensions can show another one (the owner's audit of 6c4e64e, Major 8). An instruction that names the wallet neither as its payer nor as its authority gets a row naming its kind and no text from it, such as "A memo" or "A token transfer that does not name your wallet as its authority". Each row reads the one verdict `@limen/preflight` gives its instruction (`packages/preflight/src/effect.ts`), the verdict the drain pattern and the signing gate read too: a row says a program refuses the instruction only where the program refuses it whatever the accounts hold, and that it moves nothing only for a transfer to the account it comes from (`src/tx/audit-6c4e64e.test.ts`).
2. **Fallback.** Any instruction the decoder cannot decode (an unknown program, a Token-2022 extension instruction or transfer or close, `FreezeAccount` and `ThawAccount`, `Batch`, unexpected or unreadable data, too few accounts) is listed, and the card becomes the fallback card: it says the card cannot show everything the transaction would do. So a token drain inside a program limen does not decode appears only as that flagged, undecoded instruction: limen takes no token change from a simulation (the owner's ruling 20a; `packages/preflight/README.md`).
3. **Simulate.** The pre-flight first checks the endpoint's genesis hash. Another cluster's well-formed hash stops it with a card that says so; any other answer, or none, leaves devnet unconfirmed, so the decode is shown and the card says limen could not confirm devnet and uses no simulation result (the owner's audit of 6c4e64e, Major 9). It loads any lookup tables, simulates without signature checks and with the blockhash replaced, and reports the wallet's SOL change from the simulation's own run. Under the owner's ruling 20a it reads no other account and takes nothing else from the run: no token account change, owner or data length (see `packages/preflight/README.md`). A simulation result is not used when the RPC cannot be reached or does not answer within 10 seconds, or when its answer is incomplete, contradicts itself or the instructions (a clean run of a transaction holding an instruction its program refuses whatever the accounts hold), departs from the shape agave gives it, or is for another request; the decode is still shown, and the card says no simulation result is used, shows no balance change, and shows no address from a lookup table, which the pre-flight resolves only on a clean run whose `loadedAddresses` match the tables read, leaving every lookup entry unresolved after a failed run too (the owner's audit of 6c4e64e, Major 2; the audit of 1856942, bug 1). A failed run's error is shown only as agave's error names, with the instruction's number and a `Custom` code where agave's form holds them, and otherwise as "detail not shown" (Major 5). The link itself also has 10 seconds to answer. An answer whose final URL differs from the link, its fragment aside, is refused, and the card says the request was redirected and limen will not show what it answered (`src/tx/request.test.ts`, "re-audit 2, item 7"); one that gives no final URL is refused too, and the card says limen cannot confirm it came from the link. The link's answer is read with the package's one JSON reader, so one that names a member twice is refused. The redirect is followed before limen can look: a 307 or 308 resends the POST with its body, so a cross-host 307 or 308 redirect may already have received the posted account address before limen refuses (square/okhttp `parent-4.12.0`, the same in `parent-4.9.2`, `RetryAndFollowUpInterceptor.kt:224` to `:226` and `:290` to `:330`; the Fetch standard's HTTP-redirect fetch). A 301, 302 or 303 turns the POST into a GET with no body. On Android the final URL is the one OkHttp last requested, written its own way, so a link it writes differently, such as one with an uppercase host, is refused too; this has not been run on a device. The one simulated change the card shows is the wallet's SOL. So a clean run's card with no drain pattern and every instruction decoded says other simulated changes, such as tokens moved or SOL sent to a token account by another signer, are not shown, and, when the run leaves the wallet's SOL as it was, that the balance stays the same; the fallback card says the latter too. A card whose decoded instructions hand over control says that instead (`src/tx/card-text.test.ts`, "re-audit 2, item 6", "m5" and "the audit of 21e1f9f, item 9"). A transaction limen cannot read gets a card headed "limen cannot read this transaction", which says limen cannot read it as a legacy or version 0 transaction and names the problem; it never says the transaction breaks Solana's rules.
4. **Whose wallet.** limen pre-flights only transactions your wallet pays the fee for: the summary is written for the transaction's fee payer, and a transaction whose fee payer is another wallet stops with its own card. A request that leaves the fee payer unset (the zero key, with no signatures), which the Solana Pay specification allows, is rebuilt with your wallet as fee payer, as the specification has the wallet do, and the card shows, and the wallet signs, the rebuilt transaction. The card's Fee payer row says which.
5. **Sign.** Following the specification, signing is blocked when another required signature is missing. limen also blocks it when no simulation result is used or the simulation failed. Otherwise the sign button appears on the card and stays disabled until that card has been laid out on screen. For a transaction with no signatures, the recent blockhash is replaced with the latest one before the wallet signs and sends it.

The app reads its RPC endpoint from `EXPO_PUBLIC_SOLANA_RPC_URL`, or uses the public devnet endpoint. Each answer must come from that URL with status 200 (`packages/preflight/README.md`), so it is to be written as a fetch writes a final URL: a lower-case host and no default port. On Android the final URL is the one OkHttp last requested; this has not been run on a device. Expo builds that variable into the app, so it must not carry a provider key.

The fixtures in `fixtures/tx/e09-transactions.json` are built by `fixtures/tx/generate-e09.mjs` with `@solana/web3.js` 1.99.0 and `@solana/spl-token` 0.4.15. Each case's owed summary is written from the inputs the generator used, not from the decoder.

### Trust boundary

limen trusts the allowlisted devnet RPC endpoint to report the simulation it ran. It checks the shape of every answer and refuses contradictions it can detect from the transaction and the answer alone. An endpoint that misreports a simulation can still produce a clean card, for example for lookup-table data with invalid metadata, two different answers for one table, an instruction the program always refuses that limen's verdicts do not model, a transaction over 1,232 bytes, a failure at an instruction the transaction does not contain, or a wallet SOL gain on a self-transfer. Checking each simulation against a second endpoint or a light client is H-14, for mainnet (ruling 23a).

## Run

The wallet adapter is a native module, so the app runs as a development build, not in Expo Go.

What it needs:

- Node 24 (`.nvmrc` at the repository root) and JDK 17.
- An Android emulator or device, and on it a Mobile Wallet Adapter wallet. On the emulator, the Solana Mobile fake wallet (`com.solana.mobilewalletadapter.fakewallet`).
- The Android SDK components React Native 0.88 names in `node_modules/react-native/gradle/libs.versions.toml`: platform 37 (`compileSdk`), build-tools 37.0.0, NDK 27.1.12297006, and CMake.

Environment, set in `apps/mobile/.env` (Expo reads `.env` from the project folder; git ignores it) or in the shell:

- `EXPO_PUBLIC_SOLANA_RPC_URL`: the devnet RPC endpoint. Leave it unset for the public devnet endpoint. Expo builds the value into the app, so it must not carry a provider key. The app checks the endpoint's genesis hash and stops on anything but devnet.

The API: the cards in E-04, E-08 and E-09 do not call limen's API (`services/api`). They need only the devnet RPC and, for a transaction request, the request's own https link. A unit that adds an API call adds its variable here.

Steps, from the repository root:

```bash
npm ci
cd apps/mobile
npx expo prebuild --platform android
npx expo run:android
```

`expo prebuild` writes the native project to `android/`, which git ignores. `expo run:android` builds the debug app, installs it on the connected emulator or device and starts Metro. These two steps have not yet been run for this repository (see "Not checked yet").

## Device check build (E-18)

Under the owner's ruling 13a, a test build of the app, used only for the device check, trusts one test certificate, so it can fetch the devnet fixture transaction requests from a local HTTPS server. The release build is unchanged.

| Path                                 | What it does                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/with-test-certificate.ts`   | Acts only when `LIMEN_TEST_CA_CERT` names a PEM certificate at prebuild. Then it adds that certificate as `res/raw/limen_test_ca.pem` and a network security config that trusts it for `10.0.2.2` alone. It refuses a file holding anything else, such as a key. |
| `device-check/make-certificates.mjs` | Makes a test CA and the server's certificate for `10.0.2.2` with `openssl`, into `device-check/.certs/`, which git ignores, then deletes the CA's private key.                                                                                                   |
| `device-check/serve.mjs`             | An HTTPS server on `127.0.0.1:8443`, which the emulator reaches as `10.0.2.2:8443`. `POST /drainer` answers with the E-09 drainer fixture built for the posted account, which becomes its fee payer. It logs each request and each failed TLS handshake.         |

Steps, from the repository root. The test build is the release variant, which bundles the JavaScript, so no Metro server is needed:

```bash
npm ci
node apps/mobile/device-check/make-certificates.mjs
cd apps/mobile
LIMEN_TEST_CA_CERT=device-check/.certs/ca.pem npx expo prebuild --platform android --no-install
cd android
./gradlew assembleRelease
```

For the release build, run the same prebuild without `LIMEN_TEST_CA_CERT`, after removing `android/`. Then start the server with `node apps/mobile/device-check/serve.mjs`, and show the app a QR of `solana:https://10.0.2.2:8443/drainer`. On the emulator, that QR can be a poster in the virtual scene camera: start the emulator with `-camera-back virtualscene -virtualscene-poster wall=<a PNG of that QR>`.

What was checked, on 2026-11-28:

- **Without `LIMEN_TEST_CA_CERT`:** `npx expo prebuild` wrote an Android project byte-identical to the one it writes at E-09's `b1c27af` (`diff -r`, no differences).
- **With it:** the project differs in three places. The manifest's `application` element gains `android:networkSecurityConfig`, and `res/raw` and `res/xml` are added. `res/raw/limen_test_ca.pem` is byte-identical to `ca.pem`.
- **A key file named instead:** prebuild stops with the plugin's error, and the key's text is not printed.
- **The server:**
  - At start, it checks that the drainer it builds for the fixture's user equals the fixture's drainer case, byte for byte.
  - For another posted account, the answer has that account as fee payer, and `summarizeTransaction` gives it exactly the drainer case's owed summary.
  - `curl` with the test CA gets HTTP 200, and without it refuses the certificate (exit 60).

**The device check**, on emulator-5554 on 2026-11-28, with both APKs built at `6188e0c`:

- **The setup.** The emulator was started once with `-camera-back virtualscene -virtualscene-poster wall=<a PNG of the QR>`. The wall poster takes the place of the scene's framed print in the kitchen, which the camera's start position cannot see. So the camera was moved to face it by an emulator automation macro that set the device's position to (-1.8, 0.3, 3.6) and its rotation to (0, -150, 0). After that cold boot, the emulator had not joined its `AndroidWifi` network; `adb shell cmd wifi connect-network AndroidWifi open` joined it.
- **Release build.** After Authorize in the fake wallet, the fetch failed with "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found." The server logged the client's TLS alert, certificate unknown, and no request.
- **Test build.** The server logged `POST /drainer` answered 200 for the fake wallet's account. The app showed the drainer's pre-flight card: flagged, 4.99 SOL out, a delegate approved, the simulation failed on devnet (`InvalidAccountForFee`, since that account holds no SOL), and limen holds the transaction. The card offers no sign button.

## Tests

```bash
npm test --workspace @limen/mobile
```

The script typechecks the app without Node types (`tsconfig.json`), typechecks the tests with them (`tsconfig.test.json`), then runs `node --test` on `src/**/*.test.ts`. Node 24 runs the TypeScript files directly.

The E-04 done test is `src/qr/classify.test.ts`. It reads `fixtures/qr/e04-classify.json`: ten QR texts, two of them malformed Solana Pay URLs, each with the class it owes.

The E-08 done test is `src/pay/transfer.test.ts`, which reads `fixtures/pay/e08-transfer.json` and asserts the full card result each URL owes, and `src/result-card.test.ts`, which asserts the card text for an organizer recipient and a flagged one.

The E-09 done test runs in two places. In `packages/preflight` (`npm test --workspace @limen/preflight`): `src/summary.test.ts` (each fixture transaction yields its owed summary; the drainer shows SOL balance out and a delegate approved; an unknown program is listed as undecoded; every strict prefix of a fixture is refused as truncated, and a damaged copy that parses reads as web3.js reads it), `src/preflight.test.ts` (the drainer's simulated SOL change against a recorded RPC, the devnet stop, the signing blocks and the card-shown gate) `src/drain.test.ts` (the server entry point and the drain pattern), `src/review.test.ts` (the cases from the internal read: SOL sweeps, hand-overs, time limits and signing blocks), `src/fee-payer.test.ts` (a request that leaves the fee payer unset), and `src/audit.test.ts` and `src/audit-sim.test.ts` (the cases from the owner's Codex audit). Here: `src/tx/card-text.test.ts` (the card strings, and the fallback card), `src/tx/request.test.ts` (the link's time limit) and `src/tx/audit-6c4e64e.test.ts` (the cases from the owner's audit of `6c4e64e`). The package's `src/crosscheck.test.ts` checks the parser, the account order and the decoder against `@solana/web3.js` and `@solana/spl-token` on seeded random inputs.

## Not checked yet

One native release build, of E-09 at `2a7d3e2` before the audit fixes, was installed on the Android emulator (the owner's ruling 9a): it launched, showed the camera step and the system prompt, and opened the back camera. Since then, under the owner's ruling 16c, E-18's test build of E-09 at `77f925f` showed the drainer's transaction request card on the emulator, its simulation failed, and signing was held with no sign control (evidence on #15). The clean half of that check was not run, signing on a device is unverified, and nothing since `77f925f` has run on a device. The Android package is `app.antelimen.limen` (the PM's ruling, held for the owner).

Also unverified for E-09:

- Mobile Wallet Adapter runs only in a native build, not in Expo Go. The emulator check above used one, E-18's test build, in which the Solana Mobile fake wallet authorized an account through Mobile Wallet Adapter for the drainer's request (#15). No signature has been made, and no development build has been made.
- limen does not check other signers' signatures cryptographically, which the specification has wallets do; a report says only whether a signature slot is filled. A wrong signature makes the transaction fail on chain.
- The simulation was run once against public devnet with an unfunded fixture wallet (it reported `InvalidAccountForFee`). No simulation of a funded transaction has run against devnet.
- Whether the simulated SOL balance includes the network fee is not checked.
- With no `SetComputeUnitLimit`, the card gives the most the priority fee can be (1400000 units), not the runtime's default limit, which depends on the instructions and the cluster's feature set.
- A large priority fee is shown in SOL but does not flag the card: it is not part of the drain pattern, which the owner adopted as written (ruling 7a).
