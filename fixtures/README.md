# fixtures

Test fixtures that the done tests run against: QR payloads, Solana Pay URLs and transactions.

| Path                       | What it holds                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reports/e10-reports.json` | Two report bundles for one fixture drainer, from two devices and two victim wallets. Keys are SHA-256 of fixed labels, so none belongs to anyone; the summaries are a provisional shape until E-09 |
| `lists/domain-lists.json`  | A fixture list standing in for the Phantom and PhishDestroy domain lists, with reserved `.example` and `.test` domains only. Not a snapshot of either real list                                    |
