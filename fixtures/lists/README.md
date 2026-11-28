# fixtures/lists

`domain-lists.json` is a **fixture list**. It is not a snapshot of the Phantom blocklist or the PhishDestroy list. It stands in for them so the triage service (E-11) can test the D-05 threshold, and the service loads it by default. Under the owner's ruling 2a the lists are fixture lists only: the real Phantom and PhishDestroy lists are not bundled, and pulling in the Phantom blocklist is post-event H-05. Every domain in it uses a reserved `.example` or `.test` top-level domain, so none resolves.

A domain counts as listed only on an exact, case-insensitive hostname match.
