# services/api

The Node/TypeScript backend with SQLite (D-02): check-in verification, pass minting and report triage. Built from E-02.

It runs on Node 24 with no build step: Node strips the TypeScript types at load time, and SQLite comes from the built-in `node:sqlite` module.

## Run

Copy `.env.example` to `.env` at the repository root and set `ORGANIZER_KEYPAIR_PATH` to the organizer keypair file, a JSON array of 64 integers as `solana-keygen` writes it. Then:

```bash
npm start -w @limen/api
```

The API migrates its database on start and serves `GET /health`, which returns the API version and the schema version. If `ORGANIZER_KEYPAIR_PATH` is unset, holds key material instead of a path (a value that parses as a JSON array of key bytes, or an object holding one), or names a file that is missing, unreadable, not a keypair or inconsistent, the API prints one line naming the variable and the fault, never the variable's value or the file's content, and exits with code 1. An `API_PORT` that is set but is not an integer from 1 to 65535, a value of only spaces included, stops it the same way. An empty `API_PORT=` line, as `.env.example` ships it, gives the default 8787.

What the tests show, and no more: `src/organizer-key.test.ts` checks each key error's exact message for the bad files and values it tries (including the keypair JSON set as the value), so none of them carries the path, the seed or the variable's value, and checks that no printed or serialized form of the loaded key carries the seed. `src/index.test.ts` checks that start-up with the keypair JSON as the value prints no digit, so no byte of the key, to stderr.

## Test

```bash
npm test -w @limen/api
```

| File                        | What it checks                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db.test.ts`            | An empty database migrates to schema version 1 with the six owed tables and columns                                                                                                                                                 |
| `src/server.test.ts`        | `GET /health` returns status 200 and `{ "status": "ok", "version": "0.1.0", "schema_version": 1 }`                                                                                                                                  |
| `src/organizer-key.test.ts` | The RFC 8032 test vector loads to its owed public key and signature; bad key files fail with clear errors                                                                                                                           |
| `src/index.test.ts`         | Start-up with an unset, missing or unreadable key file, key material as the path, or a port of only spaces exits 1 with one line; an empty `API_PORT=` gives 8787; a symlinked entry path still runs; a good key file serves health |
| `src/main-module.test.ts`   | The entry check counts a script reached through a symlinked file or directory                                                                                                                                                       |
