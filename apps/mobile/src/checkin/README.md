# apps/mobile/src/checkin

The app half of the check-in flow (E-05). The backend half is `POST /checkins` in `services/api/src/checkin.ts` (#45). Draft: nothing here is wired into `App.tsx` yet, and the wallet signer and the device's Ed25519 library wait on the PM's word on two packages.

| File                | What it does                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `station-qr.ts`     | Verifies a station QR on the device with E-03's rules, in E-03's order: allowlisted signer, Ed25519 signature, the five payload fields, at most 60 s old.     |
| `message.ts`        | The check-in message the wallet signs, byte for byte the text the backend rebuilds, and the registration ID check (ASCII letters, digits, `_` and `-`).       |
| `client.ts`         | Posts `{ qr, wallet, registration_id, signature }` to `<EXPO_PUBLIC_API_URL>/checkins` and turns each answer into a sentence for the participant.             |
| `flow.ts`           | Runs a check-in: verify the QR, check the registration ID, have the wallet sign, post. Nothing reaches the wallet or the server until the earlier steps pass. |
| `config.ts`         | Reads `EXPO_PUBLIC_API_URL` (the name the report panel uses too) and `EXPO_PUBLIC_STATION_SIGNERS`, the allowlisted station signer IDs.                       |
| `wallet-address.ts` | Turns an MWA account's base64 public key into its base58 address, which the backend takes.                                                                    |
| `base64.ts`         | Strict base64 and base64url, without `Buffer`.                                                                                                                |

Every module is pure TypeScript with no React Native or Node imports, so `npm test --workspace @limen/mobile` runs the code the app runs. Ed25519 and the wallet come in as functions: the tests use `node:crypto`, and the app will use the Mobile Wallet Adapter signer and an Ed25519 library once those are approved.

## What the tests check

- `station-qr.test.ts`: E-03's own fixture QRs (`fixtures/station-qr/e05-app.json`, made by E-03's `issueStationQr`) verify to the answers E-03's verifier gives. A valid QR verifies to its exact payload. An expired one is accepted at 60 s and refused at 61 s. One changed payload byte gives `bad_signature`, and no QR with any single character changed is accepted. A key off the allowlist gives `signer_not_allowlisted`.
- `message.test.ts`: the message is the owed text (the same text the backend's test owes), and its bytes are its ASCII codes.
- `flow.test.ts`: a valid QR is signed with the owed message, and a fake server that rebuilds the message as the backend does accepts the signature. An expired or foreign QR, or a malformed registration ID, reaches neither the wallet nor the server.
- `client.test.ts`, `wallet-address.test.ts`, `base64.test.ts`: the request on the wire, each refusal's sentence, base58 against `@solana/web3.js` values, and base64 against Node's `Buffer`.

## Not checked yet

- Signing through Mobile Wallet Adapter and verifying on a device. Both wait on the package approval and then on Lane B's native build running on the emulator.
- Wiring into `App.tsx`.
