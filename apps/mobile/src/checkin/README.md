# apps/mobile/src/checkin

The app half of the check-in flow (E-05). The backend half is `POST /checkins` in `services/api/src/checkin.ts` (#45). When a scanned QR is a station QR, `App.tsx` shows `CheckinPanel` under it.

| File                | What it does                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `station-qr.ts`     | Verifies a station QR on the device with E-03's rules, in E-03's order: allowlisted signer, Ed25519 signature, the five payload fields, no more than 60 s after issue, in milliseconds, and a cut-short QR refused from its `expires_at` on.                                                                                         |
| `ed25519.ts`        | The device's Ed25519, `@noble/curves` under the rules the backend applies to a wallet's signature (`walletSignatureValid`, E-05): the key and R canonical and in the prime-order subgroup, then RFC 8032's check with `zip215: false`, which itself refuses an S at or above L. It checks the station QR and the wallet's signature. |
| `message.ts`        | The check-in message the wallet signs, byte for byte the text the backend rebuilds, and the registration ID check (ASCII letters, digits, `_` and `-`).                                                                                                                                                                              |
| `mwa-signer.ts`     | Signs through Mobile Wallet Adapter: authorize on devnet, build the message for the account's base58 address, sign, and check the signature locally before anything is sent.                                                                                                                                                         |
| `mwa.ts`            | Binds `mwa-signer.ts` to the real `transact` from `@solana-mobile/mobile-wallet-adapter-protocol`. Only the app imports it.                                                                                                                                                                                                          |
| `client.ts`         | Posts `{ qr, wallet, registration_id, signature }` to `<EXPO_PUBLIC_API_URL>/checkins` and turns each answer into a sentence for the participant. A `201` whose `signature` is null, which the backend gives when a retry finds the pass already minted, is a check-in.                                                              |
| `flow.ts`           | Runs a check-in: verify the QR, check the registration ID, have the wallet sign, post. Nothing reaches the wallet or the server until the earlier steps pass.                                                                                                                                                                        |
| `CheckinPanel.tsx`  | The registration ID field, the Check in button and the answer.                                                                                                                                                                                                                                                                       |
| `config.ts`         | Reads `EXPO_PUBLIC_API_URL` (the name the report panel uses too) and `EXPO_PUBLIC_STATION_SIGNERS`, the allowlisted station signer IDs.                                                                                                                                                                                              |
| `wallet-address.ts` | Turns an MWA account's base64 public key into its base58 address, which the backend takes.                                                                                                                                                                                                                                           |
| `base64.ts`         | Strict base64 and base64url, without `Buffer`.                                                                                                                                                                                                                                                                                       |

Every module but `mwa.ts` and `CheckinPanel.tsx` is pure TypeScript with no React Native imports, so `npm test --workspace @limen/mobile` runs the code the app runs. The tests drive the wallet through a fake `transact`.

## Build settings

Set both when building the app. Expo inlines them into the bundle, so neither may hold a secret.

- `EXPO_PUBLIC_API_URL`, for example `http://10.0.2.2:8787` on the Android emulator.
- `EXPO_PUBLIC_STATION_SIGNERS`, the organizer key's signer ID: the base64url of its public key, as station QRs carry it.

## What the tests check

- `station-qr.test.ts`: E-03's own fixture QRs (`fixtures/station-qr/e05-app.json`, made by E-03's `issueStationQr`) verify to the answers E-03's verifier gives:
  - a valid QR verifies to its exact payload;
  - an expired one is accepted at 60 s and refused at 60.001 s, 60.999 s and 61 s;
  - a QR cut short by its session's end is accepted 1 ms before its `expires_at` and refused at it, including one E-03 cut to 59 s because its 60 s would have ended exactly at the session's end;
  - one changed payload byte gives `bad_signature`, and no QR with any single character changed is accepted;
  - a key off the allowlist gives `signer_not_allowlisted`.
- `ed25519.test.ts`: the device refuses the 12 speccheck vectors, the eight small-order points as key or as R (noble alone accepts each as R), and a mixed-order key whose signature Node's OpenSSL accepts; on honest keys it agrees with OpenSSL on the RFC 8032 vectors, on the fixture QRs and on 200 random signatures, valid and altered.
- `mwa-signer.test.ts`: with a fake wallet that returns the message followed by its signature, as the MWA fake wallet does:
  - the signer authorizes on devnet and signs the message built for the account's base58 address;
  - it refuses a bad signature, a changed message or no account.
- `message.test.ts`, `flow.test.ts`, `client.test.ts`, `wallet-address.test.ts`, `base64.test.ts`:
  - the message bytes;
  - a backend-style signature check of the whole flow, and that nothing reaches the wallet or the server early;
  - the request on the wire, and that a `201` with a null signature is a check-in;
  - base58 against `@solana/web3.js` values;
  - base64 against Node's `Buffer`.

`npx expo export --platform android` bundles the app with these files, which shows that their imports resolve; it does not run them.

## Not checked yet

The device run: scanning, the wallet prompt and signing through MWA on the emulator wait on Lane B's native build. Until then MWA signing is checked against a fake `transact` only.
