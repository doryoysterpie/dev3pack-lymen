# services/api

The Node/TypeScript backend with SQLite (D-02): check-in verification, pass minting and report triage. Built from E-02.

It runs on Node 24 with no build step: Node strips the TypeScript types at load time, and SQLite comes from the built-in `node:sqlite` module.

## Run

Copy `.env.example` to `.env` at the repository root and set `ORGANIZER_KEYPAIR_PATH` to the organizer keypair file, a JSON array of 64 integers as `solana-keygen` writes it. Then:

```bash
npm start -w @limen/api
```

The API migrates its database on start and serves `GET /health`, which returns the API version and the schema version. If the key path is unset, or the file is missing, unreadable or not a keypair, the API prints one line naming the path and the fault, and exits with code 1. `src/organizer-key.test.ts` checks that none of these errors, and no printed or serialized form of the loaded key, carries the seed.

## Test

```bash
npm test -w @limen/api
```

| File                        | What it checks                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/db.test.ts`            | An empty database migrates to schema version 1 with the six owed tables and columns                         |
| `src/server.test.ts`        | `GET /health` returns status 200 and `{ "status": "ok", "version": "0.1.0", "schema_version": 1 }`          |
| `src/organizer-key.test.ts` | The RFC 8032 test vector loads to its owed public key and signature; bad key files fail with clear errors   |
| `src/index.test.ts`         | Start-up with an unset, missing or unreadable key file exits 1 with one line; a good key file serves health |
