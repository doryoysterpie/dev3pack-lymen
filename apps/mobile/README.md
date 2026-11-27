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

For a Solana Pay transaction request the app connects to the wallet through Mobile Wallet Adapter on devnet, POSTs the wallet's address to the request's https link, and receives a base64 transaction. The card names the host it asked, as the Solana Pay specification asks wallets to do. Then:

1. **Decode.** The decoder lives in the shared package `@limen/preflight` (`packages/preflight`), so the server can use it too. `wire.ts` parses legacy and v0 transactions. It refuses, with a reason, what the SDK's sanitize rules refuse (a bad header, a program index of 0 or from a lookup table, an account index past the end, an empty lookup, more than 256 keys, a bad compact length), and also a signature count that differs from the required signers, a repeated key, trailing bytes and any version but legacy and 0. `decode.ts` decodes System `CreateAccount`, `Assign`, `Transfer`, `AdvanceNonceAccount` and `TransferWithSeed`; SPL Token and Token-2022 `Transfer`, `TransferChecked`, `Approve`, `ApproveChecked`, `Revoke`, `SetAuthority`, `Burn`, `BurnChecked` and `CloseAccount`, with other base token instructions by name only; Associated Token Account `Create` and `CreateIdempotent`; Compute Budget; and Memo. Instruction data of any length but the exact one is not decoded, even where a program would accept it.
2. **Fallback.** Any instruction the decoder cannot decode (an unknown program, a Token-2022 extension instruction, `Batch`, unexpected data, too few accounts) is listed, and the card becomes the fallback card: it says the card cannot show everything the transaction would do.
3. **Simulate.** The pre-flight first checks the endpoint's genesis hash and stops on anything but devnet. It loads any lookup tables, reads the user's wallet and up to 99 of the transaction's writable accounts, simulates without signature checks and with the blockhash replaced, and reports the user's SOL and token account changes. When the RPC cannot be reached, or does not answer within 10 seconds, the decode is still shown and the card says the simulation did not run. The link itself also has 10 seconds to answer.
4. **Whose wallet.** limen pre-flights only transactions your wallet pays the fee for: the summary is written for the transaction's fee payer, and a transaction whose fee payer is another wallet stops with its own card. A request that leaves the fee payer unset (the zero key, with no signatures), which the Solana Pay specification allows, is rebuilt with your wallet as fee payer, as the specification has the wallet do, and the card shows, and the wallet signs, the rebuilt transaction. The card's Fee payer row says which.
5. **Sign.** Following the specification, signing is blocked when another required signature is missing. limen also blocks it when the simulation did not run or failed. Otherwise the sign button appears on the card and stays disabled until that card has been laid out on screen. For a transaction with no signatures, the recent blockhash is replaced with the latest one before the wallet signs and sends it.

The app reads its RPC endpoint from `EXPO_PUBLIC_SOLANA_RPC_URL`, or uses the public devnet endpoint. Expo builds that variable into the app, so it must not carry a provider key.

The fixtures in `fixtures/tx/e09-transactions.json` are built by `fixtures/tx/generate-e09.mjs` with `@solana/web3.js` 1.99.0 and `@solana/spl-token` 0.4.15. Each case's owed summary is written from the inputs the generator used, not from the decoder.

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

## Tests

```bash
npm test --workspace @limen/mobile
```

The script typechecks the app without Node types (`tsconfig.json`), typechecks the tests with them (`tsconfig.test.json`), then runs `node --test` on `src/**/*.test.ts`. Node 24 runs the TypeScript files directly.

The E-04 done test is `src/qr/classify.test.ts`. It reads `fixtures/qr/e04-classify.json`: ten QR texts, two of them malformed Solana Pay URLs, each with the class it owes.

The E-08 done test is `src/pay/transfer.test.ts`, which reads `fixtures/pay/e08-transfer.json` and asserts the full card result each URL owes, and `src/result-card.test.ts`, which asserts the card text for an organizer recipient and a flagged one.

The E-09 done test runs in two places. In `packages/preflight` (`npm test --workspace @limen/preflight`): `src/summary.test.ts` (each fixture transaction yields its owed summary; the drainer shows SOL balance out and a delegate approved; an unknown program is listed as undecoded; 20000 damaged transactions are parsed or refused without a crash), `src/preflight.test.ts` (the drainer's simulated changes against a recorded RPC, the devnet stop, the signing blocks and the card-shown gate) `src/drain.test.ts` (the server entry point and the drain pattern), `src/review.test.ts` (the cases from the internal read: sweeps, hand-overs, time limits and signing blocks) and `src/fee-payer.test.ts` (a request that leaves the fee payer unset). Here: `src/tx/card-text.test.ts` (the card strings, and the fallback card) and `src/tx/request.test.ts` (the link's time limit). The package's `src/crosscheck.test.ts` checks the parser, the account order and the decoder against `@solana/web3.js` and `@solana/spl-token` on seeded random inputs.

## Not checked yet

No device or emulator check has run. The camera, the permission prompt, QR decoding and the cards on a device are unverified. An Android emulator and the Mobile Wallet Adapter fake wallet now exist, and the Android package is `app.antelimen.limen` (the PM's ruling, held for the owner). The native build, which the wallet adapter needs, has not been run: it needs build-tools 37.0.0, NDK 27.1.12297006 and CMake, which the owner's approval for the emulator setup (D-07) does not cover, so the PM holds that download for the owner. `npx expo export --platform android` bundles the app, which shows that its imports resolve; it does not run the app.

Also unverified for E-09:

- Mobile Wallet Adapter needs a native development build, which has not been made. No wallet connection or signature has been made.
- limen does not check other signers' signatures cryptographically, which the specification has wallets do. A wrong signature makes the transaction fail on chain.
- The simulation was run once against public devnet with an unfunded fixture wallet (it reported `InvalidAccountForFee`). No simulation of a funded transaction has run against devnet.
- Whether the simulated SOL balance includes the network fee is not checked.
