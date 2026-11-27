# packages/preflight

`@limen/preflight` is the Solana transaction decoder, the transaction pre-flight and the drain pattern, shared by the app (`apps/mobile`) and the server. Built in E-09. It is pure TypeScript: no React Native or Node imports, and it reaches the network only through an `Rpc` passed in.

## API

### For a server: `preflightTransaction`

```ts
import { jsonRpc, preflightTransaction } from "@limen/preflight";

const { summary, drainPattern } = await preflightTransaction(transactionBytes, {
  rpc: jsonRpc(fetch, "https://api.devnet.solana.com"),
  user, // optional: the wallet the summary is written for
});
```

- `transactionBytes` is a serialized transaction, legacy or v0.
- It checks that the endpoint is devnet (by its genesis hash), loads any lookup tables, reads the wallet and the transaction's writable accounts, simulates without signature checks and with the blockhash replaced, and decodes the result into the summary the app's card shows.
- `user` defaults to the fee payer, which is the account a Solana Pay transaction request is built for when the application sets the fee payer as the specification asks.
- `summary` is a `PreflightReport`: `{ kind: "malformed", problem }`, `{ kind: "not-devnet" }`, or `{ kind: "ready", user, summary, simulation, blocks }`.
- `drainPattern` is `drainPattern(summary)`, defined below.

The report is plain JSON: strings, numbers, booleans, null, arrays and objects. Every amount is a decimal string; there is no `bigint` and no typed array, so it can be compared as canonical JSON. `src/drain.test.ts` checks that a report survives a JSON round trip unchanged.

### An `Rpc` with no network: `recordedRpc`

```ts
import { preflightTransaction, recordedRpc } from "@limen/preflight";

const rpc = recordedRpc({
  accounts: {
    [wallet]: {
      lamports: 5000000000,
      owner: systemProgram,
      data: ["", "base64"],
    },
  },
  simulation: {
    err: null,
    accounts: {
      [wallet]: {
        lamports: 9995000,
        owner: systemProgram,
        data: ["", "base64"],
      },
    },
  },
});
const result = await preflightTransaction(drainerBytes, { rpc });
```

`recordedRpc` answers from recorded data, by address, through the same JSON-RPC parsing as `jsonRpc`. The accounts take the shape `getMultipleAccounts` and `simulateTransaction` return with base64 encoding. `genesisHash` defaults to devnet's.

### For the app

- `preflight(rpc, base64, user)` returns a `Preflight`, which also keeps the parsed transaction and its base64 for signing.
- `signingAllowed(result, shownFor)` allows signing only for a ready pre-flight with no signing blocks, once the card for that transaction is on screen.
- `forSigning(result, latestBlockhash)` replaces only the recent blockhash of a transaction with no signatures.
- `toReport(result, user)` turns a `Preflight` into a `PreflightReport`.

### Lower level

`parseTransaction`, `messageAccounts`, `decodeInstruction`, `summarizeTransaction`, `balanceChanges`, `parseTokenAccount`, `parseLookupTable`, and base58 and base64 helpers. `src/index.ts` lists every export.

## The drain pattern

`drainPattern(report)` in `src/drain.ts` is the one definition of the drain pattern, the first condition of D-05's auto-escalation threshold. E-11's threshold and E-15's claims table read it. A ready report shows a drain pattern when, for the user's wallet, any of these holds:

1. **Control handed over, in the decoded instructions:** a delegate approved over one of the wallet's token accounts; the wallet account assigned to another program; a token account or mint authority moved to an address other than the wallet; or a token account closed with its SOL sent to an address other than the wallet.
2. **Control handed over, in a simulation that ran without an error:** a token account the wallet owned has a new delegate other than the wallet, or a new owner other than the wallet.
3. **A sweep, in a simulation that ran without an error:** the wallet is left with less than a tenth of its SOL, or a token account the wallet owns is emptied without being closed.

A malformed transaction and a stop at a non-devnet endpoint never show a drain pattern. A simulation that failed, or a plain payment that leaves the wallet a tenth or more of its SOL, shows one only when the decoded instructions hand over control. The tenth is `SWEEP_DIVISOR`. The definition reads both the decoded instructions and the simulation: a stored drainer re-simulated after the wallet was already emptied can fail, and its instructions still show what it asked for.

## Using it from Node

Node 24 runs the package's TypeScript directly. The workspace link `node_modules/@limen/preflight` resolves to `packages/preflight`, outside `node_modules`, so Node strips its types. Imports inside the package carry the `.ts` extension.

## Tests

```bash
npm test --workspace @limen/preflight
```

The script typechecks the package with no Node or DOM types, typechecks the tests with Node types, then runs `node --test` on `src/**/*.test.ts`. The fixtures are in `fixtures/tx/`, built by `fixtures/tx/generate-e09.mjs` with `@solana/web3.js` 1.99.0 and `@solana/spl-token` 0.4.15, which are dev dependencies of this package only. `src/crosscheck.test.ts` checks the parser, the account order and the decoder against those libraries on seeded random inputs.

## Sources

Layouts and rules come from the program sources at pinned commits, named at the top of each file: anza-xyz/solana-sdk `7b382f6`, solana-program/token `38de8d1`, solana-program/token-2022 `efe55b4`, solana-program/associated-token-account `34509e4`, and the Solana Pay specification at solana-foundation/pay `8e1b87c`.

## Not verified

- Other signers' signatures are not checked cryptographically.
- No funded transaction has been simulated against devnet.
- The drain pattern definition is limen's; D-05 names the condition but does not define it.
