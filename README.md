# <picture><source media="(prefers-color-scheme: dark)" srcset="assets/limen-logo-light.svg"><img src="assets/limen-logo.svg" alt="limen" height="64"></picture>

limen is a mobile build-station check-in pass with QR pre-flight, and a report triage service, on Solana devnet.

- **Check-in pass.** A participant scans a signed, rotating QR on a station screen and signs a check-in message with their wallet. The backend verifies the check-in and mints a non-transferable Token-2022 pass.
- **QR pre-flight.** The app shows what a QR will do before you act on it: a station check-in, a Solana Pay transfer, a transaction request or a plain link. For a transaction request, it shows what the transaction would do before you sign.
- **Report triage.** A participant can report a QR. The service groups reports into cases, holds each case for a human unless the D-05 threshold is met, and escalates evidenced cases to Chainabuse and the Phantom blocklist.

## Status

Repository skeleton only (E-01). Each feature lands with its unit, E-02 to E-17, and the claims table below records what each check proves once it exists.

## Built before and during the event

The owner lists these as existing before the event opened: planning documents, the landing page in the separate `limen-site` repository, the antelimen handles and the antelimen.app domain. None of them is in this repository.

Everything in this repository was built during the event. To see the first commit and its time, run:

```bash
git log --reverse --format='%h %cI %s' | head -1
```

## Layout

| Path           | What it holds                                               |
| -------------- | ----------------------------------------------------------- |
| `apps/mobile`  | Expo React Native app with Mobile Wallet Adapter            |
| `apps/station` | Vite page for the station display                           |
| `services/api` | Node/TypeScript backend with SQLite                         |
| `fixtures`     | Fixtures the done tests run against                         |
| `docs`         | The decisions table, [docs/decisions.md](docs/decisions.md) |

## Run

Run instructions arrive as the units land. For now the repository runs its lint, format and type checks. It needs Node 24 (see `.nvmrc`).

```bash
npm ci
npm run check
```

Local secrets go in `.env`, copied from `.env.example`. Git ignores `.env`.

## What each check proves

Filled at E-15: one row per check, with the code that runs it.

| Check | What it proves | What it does not prove | Code |
| ----- | -------------- | ---------------------- | ---- |

## No custom on-chain program (D-01)

limen deploys no custom on-chain program. The pass is a Token-2022 mint with the non-transferable extension, a metadata pointer, and the organizer key as permanent delegate for revocation. The backend holds mint authority and mints after verifying the check-in. A custom program for the check-in registry is post-event item H-01.

limen runs on Solana devnet only (D-03).

## Design rationale

1. Issuance binds to presence: a short-lived signed nonce on the station screen, not a shareable link.
2. Non-transferable from mint, with organizer revocation.
3. One pass per registered participant per session.
4. A consumer exists: perks, demo-day voting and accelerator applications read the pass.
5. Defined issuer set, sessions only, no promotional drops.
6. Organizers self-serve with their own keys. No curation body.
7. The pass claims exactly what it proves: this wallet completed a signed check-in at station X during window Y.

## Post-event hardening

| ID                                                                | Item                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [H-01](https://github.com/doryoysterpie/dev3pack-lymen/issues/24) | Custom program for the check-in registry                                      |
| [H-02](https://github.com/doryoysterpie/dev3pack-lymen/issues/25) | Seed Vault key custody                                                        |
| [H-03](https://github.com/doryoysterpie/dev3pack-lymen/issues/26) | Token-2022 extensions, if deferred on Day 1                                   |
| [H-04](https://github.com/doryoysterpie/dev3pack-lymen/issues/27) | NFC tap as a second presence channel                                          |
| [H-05](https://github.com/doryoysterpie/dev3pack-lymen/issues/28) | Phantom blocklist pull-request automation                                     |
| [H-06](https://github.com/doryoysterpie/dev3pack-lymen/issues/29) | Chainabuse GET lookup at scan time                                            |
| [H-07](https://github.com/doryoysterpie/dev3pack-lymen/issues/30) | Real registration import from the organizer's applicant list                  |
| [H-08](https://github.com/doryoysterpie/dev3pack-lymen/issues/31) | Solana Mobile dApp Store listing                                              |
| [H-09](https://github.com/doryoysterpie/dev3pack-lymen/issues/32) | SEAL-ISAC application for the triage team, if the team exists after the event |

## Licence

MIT. See [LICENCE](LICENCE).
