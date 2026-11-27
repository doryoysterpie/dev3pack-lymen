# fixtures/lists

`domain-lists.json` is a **fixture list**. It is not a snapshot of the Phantom blocklist or the PhishDestroy list. It stands in for them so the triage service (E-11) can test the D-05 threshold, and the service loads it by default until the owner rules on snapshotting the real lists. Every domain in it uses a reserved `.example` or `.test` top-level domain, so none resolves.

A domain counts as listed only on an exact, case-insensitive hostname match.
