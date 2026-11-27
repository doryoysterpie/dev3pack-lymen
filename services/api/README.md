# services/api

The Node/TypeScript backend with SQLite (D-02): check-in verification, pass minting and report triage. Built from E-02.

It runs on Node 24 with no build step: Node strips the TypeScript types at load time, and SQLite comes from the built-in `node:sqlite` module.

## Run

Copy `.env.example` to `.env` at the repository root and set `ORGANIZER_KEYPAIR_PATH` to the organizer keypair file, a JSON array of 64 integers as `solana-keygen` writes it. Then:

```bash
npm start -w @limen/api
```

The API migrates its database on start and serves `GET /health`, which returns the API version and the schema version. If `ORGANIZER_KEYPAIR_PATH` is unset, holds key material instead of a path (a value that parses as a JSON array of key bytes, or an object holding one), or names a file that is missing, unreadable, not a keypair or inconsistent, the API prints one line naming the variable and the fault, never the variable's value or the file's content, and exits with code 1. The API takes `API_PORT` as it receives it: unset or empty gives the default 8787, and any other value that is not an integer from 1 to 65535, a value of only spaces included, stops it the same way. Set in the environment, a value of only spaces reaches the API as it is and is refused. In `.env`, Node 24 keeps spaces only inside quotes, so `API_PORT="   "` is refused too, and an empty `API_PORT=` line, as `.env.example` ships it, gives 8787. An unquoted `API_PORT=` followed by only spaces also gives 8787 when it is the file's last setting or the next line that is not blank is a comment, as in `.env.example`. When the next line that is not blank is another setting, Node reads that whole line as the value of `API_PORT` and leaves its variable unset, so the API refuses the value and exits 1.

What the tests show, and no more: `src/organizer-key.test.ts` checks each key error's exact message for the bad files and values it tries (including the keypair JSON set as the value), so none of them carries the path, the seed or the variable's value, and checks that no printed or serialized form of the loaded key carries the seed. `src/index.test.ts` checks that start-up with the keypair JSON as the value prints no digit, so no byte of the key, to stderr.

## Registrations (E-07)

Set `REGISTRATION_SALT` in `.env` (at least 32 characters), then import the registration list, a JSON array of registration IDs:

```bash
npm run import-registrations -w @limen/api -- ../../fixtures/registrations.json
```

The database stores only HMAC-SHA256 hashes of the IDs, keyed by the salt. An ID must be 1 to 64 ASCII letters, digits, `_` or `-` after trimming; it is upper-cased only after that check, so no other letter can map onto it. A wallet must be base58 that decodes to exactly 32 bytes. If the list file is not valid JSON, the tool names the file and, when the parser gives one, the line and column, never the file's content. `fixtures/registrations.json` is a mock list of ten IDs. A real import from the organizer's applicant list is H-07.

## Reports (E-10)

`POST /reports` takes a JSON evidence bundle from the app and stores it as a sighting with no case yet. The fields are `device_id` (an install-scoped ID, stored only as a SHA-256 hash), `payload` (the QR text), `url`, `transaction` (base64, at most 1232 bytes), `simulation` (`slot` and `blockhash` of the app's simulation), `summary` (the decoded summary the app showed, stored as canonical JSON), `program_ids`, `recipients`, `timestamp` (Unix seconds, at most 300 s ahead of the server's clock and inside the range a JavaScript date can hold) and `app_version`. The `wallet` field is stored only when the bundle sets `include_wallet` to `true`. Without it, a `wallet` that is text is dropped and a `wallet` that is not text is refused with `400`. The wallet field not being stored does not keep the wallet out of the bundle: the stored transaction bytes name the signing wallet as an account key, and they stay whole because re-simulation needs them (owner ruling 3a).

The response is `201` with `{ "sighting_id": n, "resimulation": "not_run" }`. Once the E-09 decoder is bound as the re-simulator, `resimulation` says what the re-simulation of the stored bytes did: `matches` or `differs` against the stored summary, `no_transaction` for a bundle with no transaction, or `failed` when the re-simulation could not run. A match compares the report's `kind` and its `summary` of decoded instructions, and nothing else (owner ruling 7a). It leaves out three fields. The `simulation` holds balance changes, which drift as account state moves. `blocks` holds `simulation-not-run` and `simulation-failed`, which come from the simulation's outcome; its other block, `cosigner-missing`, comes from the summary's signers, which are compared. `feePayerSet` is true in the app's report when limen rebuilt the request with the wallet as fee payer, and false in a replay of those stored, rebuilt bytes. A report with no `summary`, such as a refusal, compares on its kind alone. One part of `summary` still depends on account state: its "user token account N" markers come partly from the account reads before and after the simulation, so a token account closed between the report and the replay can still read `differs`. A failed re-simulation is recorded on the bundle, and the answer is still `201`, so a client never needs to retry a stored report. A re-simulation that has not answered within 15 s counts as failed in the same way. A malformed bundle gets `400` with the first failing field named, and nothing is stored.

## Triage (E-11)

Each stored report is triaged into a case at once, and the response adds `case_id` and `case_status`. A case is keyed by a dedup hash: SHA-256 over canonical JSON of the version tag `limen:case:v1`, the URL's hostname, the sorted program IDs and the sorted recipients. The hostname is normalized first: lower case, punycode for non-ASCII labels, and one trailing dot dropped, so `Listed.Example.` and `listed.example` key one case and match one list entry. Bundles that differ only in transaction bytes, wallet or device land in one case.

The program IDs and recipients in the key are the lists the reporter sent. The server checks that each entry is a public key, but not that the lists match the transaction bytes, so a report whose lists differ from its bytes lands in a separate case. Once the E-09 decoder is wired into the server, the key will use what the server derives from the bytes instead.

A new case holds for a human. It escalates automatically only on the D-05 threshold, `autoEscalates` in `src/triage.ts`: the simulation shows a drain pattern AND (two or more independent devices reported it OR the domain is on the Phantom or PhishDestroy list). Here "the simulation shows a drain pattern" means a server re-simulation reproduced a stored summary in the case and that summary shows one, so a reporter's own claim never counts. "Independent devices" means distinct device IDs; nothing checks that two IDs are two phones. The lists are the fixture lists in `fixtures/lists`, not the real lists, and a domain matches only by exact hostname after the same normalization. Only a held case can escalate; an escalated or dismissed case keeps its status.

## Test

```bash
npm test -w @limen/api
```

| File                        | What it checks                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db.test.ts`            | An empty database migrates to schema version 3 with the seven owed tables and columns; migration 3 keeps E-02 case rows and rolls back rather than orphan a sighting                                                                                                                                                                                                 |
| `src/server.test.ts`        | `GET /health` returns status 200 and `{ "status": "ok", "version": "0.1.0", "schema_version": 3 }`                                                                                                                                                                                                                                                                   |
| `src/organizer-key.test.ts` | The RFC 8032 test vector loads to its owed public key and signature; bad key files fail with clear errors                                                                                                                                                                                                                                                            |
| `src/index.test.ts`         | Start-up with an unset, missing or unreadable key file, key material as the path, a port of only spaces, or a `.env` line that Node hands over as spaces or as the next line, exits 1 with one line; each `.env` layout tried reaches the API as Node reads it, and only an empty value gives 8787; a symlinked entry path still runs; a good key file serves health |
| `src/main-module.test.ts`   | The entry check counts a script reached through a symlinked file or directory                                                                                                                                                                                                                                                                                        |
| `src/registration.test.ts`  | A registration bound to one wallet refuses a second wallet, and nothing changes; hashes match Python's HMAC; wallets must decode to 32 bytes; non-ASCII IDs are refused; the import tool runs through a symlink and never quotes a malformed list                                                                                                                    |
| `src/base58.test.ts`        | The System Program and Token program IDs decode to their owed bytes; only 32-byte keys count as public keys                                                                                                                                                                                                                                                          |
| `src/evidence.test.ts`      | A fixture bundle stores and loads back with its owed fields and no wallet field, while its bytes still name the signing wallet; malformed fields and out-of-range timestamps are refused by name; re-simulation receives the stored bytes, and a failed one is recorded. The E-10 done test waits on the E-09 decoder                                                |
| `src/reports.test.ts`       | `POST /reports` stores the fixture bundle as sighting 1 in held case 1, puts the second device's bundle in the same case, still answers 201 once and triages the report when the re-simulator fails or never answers, and refuses malformed, oversized, non-JSON and future-dated bodies                                                                             |
| `src/triage.test.ts`        | E-11 done test: two bundles from different devices for one drainer make one case with two sightings; the threshold gives the D-05 answer for every input combination and at the case level; hostnames are normalized, so a trailing dot neither escapes a list nor splits a case                                                                                     |
