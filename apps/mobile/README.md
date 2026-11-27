# apps/mobile

The Expo React Native app with Mobile Wallet Adapter (D-02): the scanner, the QR pre-flight cards and the check-in flow. Built from E-04. It uses Expo SDK 58 and React Native 0.88.1, the versions in Expo's SDK 58 TypeScript template.

## What is here

| Path                           | What it does                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `App.tsx`                      | Camera screen. It asks for camera access, reads QR codes with `expo-camera`, classifies the text and shows a result card with the scanned text. |
| `src/qr/classify.ts`           | QR type detection, a pure module: station, Solana Pay transfer request, Solana Pay transaction request, http or https URL, or other.            |
| `src/qr/base58.ts`             | Base58 decoding, used to check that a Solana Pay recipient is a 32-byte public key.                                                             |
| `src/qr/describe.ts`           | Result-card text for each QR class, kept in one place for the copy rules.                                                                       |
| `src/pay/transfer.ts`          | Transfer request card fields, from the classifier's parsed fields, a pure module.                                                               |
| `src/pay/recipient-lists.ts`   | Loads the organizer allowlist and the known-scam list and gives a recipient its status.                                                         |
| `src/pay/recipient-lists.json` | The devnet fixture lists the app bundles. Both are empty until the organizer key and the demo list are added.                                   |
| `src/pay/card-text.ts`         | Transfer card text.                                                                                                                             |
| `src/result-card.ts`           | Picks the card for a scanned QR: the transfer card for a transfer request, the E-04 summary for anything else.                                  |
| `src/ui/CardView.tsx`          | Renders a card.                                                                                                                                 |

## How a QR is classified

- **Station**: the text starts with `limen:station:`. The prefix alone decides it. E-05 verifies the signature; nothing in E-04 does.
- **Solana Pay**: the URL scheme is `solana:`. As in the reference `parseURL` of the Solana Pay specification, a pathname holding `:` or `%` is a transaction request link, which must URL-decode to an absolute https URL. Any other pathname is a transfer request recipient, which must be base58 that decodes to 32 bytes. A transfer request's query is read and checked here too. Its fields are decoded with `decodeURIComponent`, the function SPEC.md links, so a `+` stays a `+` (the reference `parseURL` uses form decoding, which would read a space), and a field that is not valid percent-encoding is refused. The checks run in this order: `amount`, `spl-token`, `label`, `message` and `memo` may each appear once; the amount must be a non-negative integer or decimal with a leading 0 below 1 and no scientific notation, with at most 9 decimal places when it is SOL; `spl-token` and every `reference` must decode to 32 bytes. As in the reference `parseURL`, a `solana:` URL longer than 2048 characters is refused. A `solana:` URL that breaks any rule is "other" with the reason `malformed-solana-pay` and the problem it has. This is the one place a Solana Pay URL is parsed.
- **URL**: the URL scheme is `http:` or `https:`.
- **Other**: anything else.

URLs are parsed with `whatwg-url-minimum`, the package Expo installs as the global `URL` on the device, so the Node tests run the parser the app runs.

## Transfer request card (E-08)

For a Solana Pay transfer request the card shows the recipient, the amount, the token (SOL, or an SPL token by its mint), any references, and the label, message and memo marked as written in the QR. `src/pay/transfer.ts` does not parse the URL: it reads the fields and the problem `src/qr/classify.ts` returns, so the transfer request rules live in one place. The one rule it adds is the SPL token decimal check, which needs the mint's decimals; the app does not look those up, so an SPL token amount shows that its decimal places were not checked.

The recipient's status comes from `src/pay/recipient-lists.json`, a devnet fixture list bundled with the app: **flagged** when the address is on its flagged list, **organizer** when it is on its organizer list, otherwise neither. A recipient on both is flagged. Flagged means only that the address is on that bundled list; the app checks no feed of real scam reports. The organizer list is empty until the organizer key exists (E-06).

A malformed transfer request gets a card that names its problem, from the classifier's list.

## Tests

```bash
npm test --workspace @limen/mobile
```

The script typechecks the app without Node types (`tsconfig.json`), typechecks the tests with them (`tsconfig.test.json`), then runs `node --test` on `src/**/*.test.ts`. Node 24 runs the TypeScript files directly.

The E-04 done test is `src/qr/classify.test.ts`. It reads `fixtures/qr/e04-classify.json`: ten QR texts, two of them malformed Solana Pay URLs, each with the class it owes.

The E-08 done test is `src/pay/transfer.test.ts`, which reads `fixtures/pay/e08-transfer.json` and asserts the full card result each URL owes, and `src/result-card.test.ts`, which asserts the card text for an organizer recipient and a flagged one.

## Not checked yet

No device or emulator check has run. The camera, the permission prompt, QR decoding and the cards on a device are unverified until the Android emulator exists. `npx expo export --platform android` bundles the app, which shows that its imports resolve; it does not run the app.
