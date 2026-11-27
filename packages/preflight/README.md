# packages/preflight

`@limen/preflight` is the Solana transaction decoder, the transaction pre-flight and the drain pattern, shared by the app (`apps/mobile`) and the server. Built in E-09. It is pure TypeScript: no React Native or Node imports, and it reaches the network only through an `Rpc` passed in.

## API

### For a server: `preflightTransaction`

```ts
import { jsonRpc, preflightTransaction } from "@limen/preflight";

const { summary, drainPattern, simulatedAt } = await preflightTransaction(
  transactionBytes,
  { rpc: jsonRpc(fetch, "https://api.devnet.solana.com") },
);
```

- `transactionBytes` is a serialized transaction, legacy or v0.
- It checks that the endpoint is devnet (by its genesis hash), loads any lookup tables, reads the fee payer's wallet and the transaction's writable accounts, simulates without signature checks and with the blockhash replaced, and decodes the result into the summary the app's card shows.
- Whose wallet: **limen pre-flights only transactions the user's wallet pays the fee for.** The summary is always written for the transaction's fee payer, its first required signer, read from the bytes, so the app and a server summarize the same bytes the same way. An optional `user` names the wallet the caller expects; any other wallet is refused with `{ kind: "user-not-fee-payer", feePayer }`, never summarized. Leaving `user` out and giving the fee payer return the same result; `src/drain.test.ts` checks that.
- A request may leave the fee payer unset: the Solana Pay specification (solana-foundation/pay 8e1b87c, "POST Response") lets an application send a transaction with no signatures and the zero key as fee payer, and has the wallet set its own account. limen does the same before anything else, by the rules in `src/fee-payer.ts`, and the report says so with `feePayerSet: true`. The card, the simulation and the signature then all cover the rebuilt transaction. With no `user` there is no wallet to set, and the result is `{ kind: "fee-payer-not-set" }`. A server that holds such a request passes the account it asked for as `user`. `src/fee-payer.test.ts` checks three rebuilds (a legacy SOL transfer, a v0 transaction with a lookup table, and a request that does not name the wallet) against `@solana/web3.js` compiling the same instructions with the wallet as fee payer, and checks that a zero key named as an account, as an associated token account creation names the System Program, leaves a signature missing, which holds signing.
- `summary` is a `PreflightReport`: `{ kind: "malformed", problem }`, `{ kind: "not-devnet" }`, `{ kind: "user-not-fee-payer", feePayer }`, `{ kind: "fee-payer-not-set" }`, or `{ kind: "ready", feePayerSet, summary, simulation, blocks }`. In a ready report, `summary` is `{ effects, others, undecoded, signers, unresolvedAccounts }`: each instruction the wallet does not authorize appears in `others` as its index and kind only, and `signers` is `{ feePayer, others, unsigned }`. It is the form the E-09 fixtures' owed summaries take.
- No wallet address: wherever the user's wallet would appear, in `signers.feePayer`, in an effect or in a balance change, the summary writes the role marker `"user"` (`USER_MARKER`) instead of its address. A report therefore carries no wallet address, and the app and a server produce the same report for the same bytes. `src/report.test.ts` checks every fixture transaction's report for the fee payer's address. `simulation` is `{ status: "ran", err, changes }` or `{ status: "not-run", reason }`. A simulation is marked not run when the endpoint cannot be reached, when an answer or its body takes longer than `RPC_TIMEOUT_MS` (10 seconds; `jsonRpc(fetch, url, timeoutMs)` takes another limit), and when the `simulateTransaction` answer has no `err` field or, for a run without an error, no accounts.
- `blocks` lists why signing waits: `"cosigner-missing"` when another required signature is missing, `"simulation-not-run"`, or `"simulation-failed"`.
- `drainPattern` is `drainPattern(summary)`, defined below.
- `simulatedAt` is `{ slot, blockhash }`, the slot from the `simulateTransaction` response context and the blockhash simulated against in place of the transaction's own, or `null` when no simulation ran. It sits outside the summary because a later simulation of the same bytes runs at another slot.

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

`recordedRpc` answers from recorded data, by address, through the same JSON-RPC parsing as `jsonRpc`. The accounts take the shape `getMultipleAccounts` and `simulateTransaction` return with base64 encoding. `genesisHash` defaults to devnet's; `simulation.slot` and `simulation.replacementBlockhash` are optional and come back as `simulatedAt`.

### For the app

- `preflight(rpc, base64, user?)` returns a `Preflight`, which also keeps the parsed transaction, its base64 and `simulatedAt`. The app passes the connected wallet as `user`, so another wallet's transaction is refused.
- `signingAllowed(result, shownFor)` allows signing only for a ready pre-flight with no signing blocks, once the card for that transaction is on screen. With a block, including a simulation that did not run or failed, the card is shown and signing waits.
- `forSigning(result, latestBlockhash)` replaces only the recent blockhash of a transaction with no signatures.
- `toReport(result)` turns a `Preflight` into a `PreflightReport`.

### Lower level

`parseTransaction`, `messageAccounts`, `decodeInstruction`, `summarizeTransaction`, `balanceChanges`, `parseTokenAccount`, `parseLookupTable`, and base58 and base64 helpers. `src/index.ts` lists every export.

## The drain pattern

`drainPattern(report)` in `src/drain.ts` is the one definition of the drain pattern, the first condition of D-05's auto-escalation threshold. E-11's threshold, E-15's claims table and the app's card read it; the card's "hands over control" flag uses the same `handsOverControl`. The definition is limen's: D-05 names the condition without defining it, so it is held for the owner. A ready report shows a drain pattern when, for the user's wallet (the fee payer, written `"user"`), any of these holds:

1. **Control handed over, in the decoded instructions:** a delegate approved over one of the wallet's token accounts; the wallet account assigned to another program; a token account or mint authority moved to an address other than the wallet; or a token account closed with its SOL sent to an address other than the wallet.
2. **Control handed over, in a simulation that ran without an error:** the wallet account given a new owner program or a different data length; or a token account the wallet owned given a new delegate other than the wallet, a raised allowance for a delegate other than the wallet, a new owner other than the wallet, or a new close authority other than the wallet.
3. **A sweep, in a simulation that ran without an error:** the wallet, or a token account the wallet owned, left with less than a tenth of what it held. A closed token account counts as left with nothing.

A request whose fee payer is unset is checked as rebuilt with the wallet as fee payer. A malformed transaction, a stop at a non-devnet endpoint, another wallet's transaction, and a request whose fee payer is unset when no wallet is given never show a drain pattern. A simulation that failed shows one only when the decoded instructions hand over control. The tenth is `SWEEP_DIVISOR`. The definition reads both the decoded instructions and the simulation: a stored drainer re-simulated after the wallet was already emptied can fail, and its instructions still show what it asked for.

What the definition does not look at: where the SOL or tokens go. A payment to the event organizer of a whole token balance, or of more than nine tenths of the wallet's SOL, shows a drain pattern; so does unwrapping wrapped SOL back to the wallet, which closes a token account that held a balance. `src/review.test.ts` holds the cases.

## Using it from Node

Node 24 runs the package's TypeScript directly. The workspace link `node_modules/@limen/preflight` resolves to `packages/preflight`, outside `node_modules`, so Node strips its types. Imports inside the package carry the `.ts` extension.

## Tests

```bash
npm test --workspace @limen/preflight
```

The script typechecks the package with no Node or DOM types, typechecks the tests with Node types, then runs `node --test` on `src/**/*.test.ts`. The fixtures are in `fixtures/tx/`, built by `fixtures/tx/generate-e09.mjs` with `@solana/web3.js` 1.99.0 and `@solana/spl-token` 0.4.15, which are dev dependencies of this package only. `src/crosscheck.test.ts` checks the parser, the account order and the decoder against those libraries on seeded random inputs.

## Sources

Layouts and rules come from the program sources at pinned commits, named at the top of each file: anza-xyz/solana-sdk `7b382f6`, solana-program/token `38de8d1`, solana-program/token-2022 `efe55b4`, solana-program/associated-token-account `34509e4`, anza-xyz/agave `a64fa73` for the priority fee (`src/fee.ts`), and the Solana Pay specification at solana-foundation/pay `8e1b87c`.

## Not verified

- Other signers' signatures are not checked cryptographically.
- No funded transaction has been simulated against devnet.
- The drain pattern definition is limen's; D-05 names the condition but does not define it.
- With no `SetComputeUnitLimit`, the priority fee effect gives the most the fee can be, at 1400000 units; limen does not work out the runtime's default limit, which depends on the instructions and the cluster's feature set.
