# Standing rules (these bind every unit)

Copied word for word from the kickoff plan. Every session and every Codex audit in this repo reads the same rules. The units and their rulings are the repo's issues.

1. Nothing existed in this repo before H+0. The first commit is made now. The README states what existed before the event (planning documents, the landing page in the separate `limen-site` repo, handles, domain) and what was built during it. The hackathon rules require that statement.
2. Unit convention: D-nn decisions, E-nn build units, H-nn post-event hardening. One issue per unit. Rulings are recorded on the issue. If a unit needs a ruling that is not on its issue, stop and ask. Never assume one.
3. Every claim in the README and in the app states what was checked. Write "No known issues in the checks run", never "safe". Every factual claim in a unit close carries a file:line, a runnable command, or the word "unverified".
4. Each unit's done test requires the answer the code owes for the input, not survival or self-consistency. A test that only shows the code ran does not close a unit.
5. E-03, E-05 and E-09 each get one Codex audit. When one of these passes its done test, stop, post the close evidence, and leave the issue open for the audit. Everything else gets a scoped check only.
6. Finish over polish. Add nothing to scope. If you see a worthwhile addition, file it as a new H-nn issue and move on.
7. Devnet only. No mainnet endpoint, key or address anywhere in the repo.
8. No secrets in git. Keypairs, the RPC key and Chainabuse credentials load from `.env` or a gitignored path. Commit a `.env.example` with names only. Never print a secret to the terminal or to an issue.
9. Copy rules for the README, app strings and issue text: Canadian spelling (licence, organizer, colour, behaviour, centre). No em dashes or en dashes. These words never appear: safe, secure, protects, guaranteed, unhackable, scam-proof, revolutionary, game-changing. Allowed framings: "shows what the transaction would do before you sign", "no known issues in the checks run", "flags", "escalates with evidence", "holds for a human".
10. The product repo holds product code only. No social plan, no post copy, no landing page code.
