# packages/preflight

`@limen/preflight` is the Solana transaction decoder, the transaction pre-flight and the drain pattern, shared by the app (`apps/mobile`) and the server. Built in E-09. It is pure TypeScript: no React Native or Node imports, and it reaches the network only through an `Rpc` passed in.

## API

### For a server: `preflightTransaction`

```ts
import { jsonRpc, preflightTransaction } from "@limen/preflight";

const { summary, drainPattern, simulatedAt } = await preflightTransaction(
  transactionBytes,
  { rpc: jsonRpc(fetch, "https://api.devnet.solana.com"), user: wallet },
);
```

- `transactionBytes` is a serialized transaction, legacy or v0.
- It checks that the endpoint is devnet (by its genesis hash), loads any lookup tables, reads the fee payer's wallet and the transaction's writable accounts, simulates without signature checks and with the blockhash replaced, reads the same accounts again, and decodes the result into the summary the app's card shows.
- What it decodes: System `CreateAccount`, `Assign` (to a program other than the System Program), `Transfer`, `AdvanceNonceAccount` and `TransferWithSeed`; Token program `Transfer`, `TransferChecked`, `Approve`, `ApproveChecked`, `Revoke`, `SetAuthority`, `MintTo`, `MintToChecked`, `Burn`, `BurnChecked` and `CloseAccount`; the same on Token-2022 except `Transfer`, `TransferChecked` and `CloseAccount`, whose effect depends on the mint's extensions (a transfer fee credits less than the amount, a transfer hook calls another program, and a close can close a mint: solana-program/token-2022 `efe55b4`, `program/src/processor.rs:574`, `:611`, `:1339`); `InitializeAccount`, `SyncNative`, `InitializeAccount3` and `InitializeImmutableOwner` by name only, at their exact length; Associated Token Account `Create` and `CreateIdempotent`; Compute Budget; and Memo. Everything else, `FreezeAccount` and `ThawAccount` among it, is listed as undecoded and turns the card into the fallback card. A token instruction is the wallet's only when the wallet is the authority account itself and signs (`authorizedByUser`, from the programs' `validate_owner`); a multisig the wallet is one signer of is not the wallet.
- Whose wallet: **limen pre-flights only transactions the user's wallet pays the fee for.** `user` names that wallet, and every call gives it. With no `user`, or one that is not a public key, the result is `{ kind: "user-not-given" }` and nothing is summarized. A transaction whose fee payer, its first required signer, is another wallet is refused with `{ kind: "user-not-fee-payer", feePayer }`, never summarized. So the app and a server summarize the same bytes the same way. `src/drain.test.ts` checks both stops.
- A request may leave the fee payer unset: the Solana Pay specification (solana-foundation/pay 8e1b87c, "POST Response") lets an application send a transaction with no signatures and the zero key as fee payer, and has the wallet set its own account. limen does the same before anything else, by the rules in `src/fee-payer.ts`, and the report says so with `feePayerSet: true`. The card, the simulation and the signature then all cover the rebuilt transaction. A server that holds such a request passes the account it asked for as `user`, as for any other. `src/fee-payer.test.ts` checks three rebuilds (a legacy SOL transfer, a v0 transaction with a lookup table, and a request that does not name the wallet) against `@solana/web3.js` compiling the same instructions with the wallet as fee payer, and checks that a zero key named as an account, as an associated token account creation names the System Program, leaves a signature missing, which holds signing.
- `summary` is a `PreflightReport`: `{ kind: "malformed", problem }`, `{ kind: "not-devnet" }`, `{ kind: "user-not-fee-payer", feePayer }`, `{ kind: "user-not-given" }`, or `{ kind: "ready", feePayerSet, summary, simulation, blocks }`. A refusal holds no summary. In a ready report, `summary` is `{ effects, others, undecoded, signers, unresolvedAccounts }`: each instruction the wallet does not authorize appears in `others` as its index and kind only, and `signers` is `{ feePayer, others, unsigned }`, each other signer with `signatureFilled`, which says only that its signature slot is not empty: limen does not verify signatures. It is the form the E-09 fixtures' owed summaries take.
- No wallet address: wherever the user's wallet would appear, in `signers.feePayer`, in an effect or in a balance change, the summary writes the role marker `"user"` (`USER_MARKER`) instead of its address. A report also writes `"user token account 1"`, `"user token account 2"` and so on, in the message's account order, for the wallet's token accounts: those the reads around the simulation show it owns, and, from the decoded instructions, an account the wallet approves from, revokes on with the Token program, or changes the owner of as its direct authority (which only the owner may sign; Token-2022's `Revoke` also accepts the delegate, `processor.rs:729`), or an associated token account created for it. It writes `"user-authorized token account N"` for any other token account a decoded token instruction acts on with the wallet as its signing authority, owner or delegate. The reason a simulation result is not used and the runtime's error have every address replaced with `"an address"` (`scrubAddresses`), object keys included, since that text comes from the RPC. The app and a server produce the same report for the same bytes. `src/report.test.ts` owes, for every fixture transaction with the wallet's two token accounts on record, no occurrence of the wallet's address or of either account's, and owes the scrubbed text; `src/review.test.ts` owes each way a token account is found to be the wallet's. With no simulation result used, a token account of the wallet that no wallet-authorized instruction names, such as the destination of a transfer, appears by its address. `simulation` is `{ status: "ran", err, changes }` or `{ status: "not-run", reason }`; "not-run" means no result is used. That is so when the endpoint cannot be reached or answers another request, when an answer or its body takes longer than `RPC_TIMEOUT_MS` (10 seconds; `jsonRpc(fetch, url, timeoutMs)` takes another limit), when the `simulateTransaction` answer has no `err` field, a different number of accounts than asked, or no `preBalances`, `postBalances` and token balances of its own run, when an amount is not a whole number, when the transaction can write more than 100 accounts or a writable account sits behind a lookup table limen could not read, and when the read after the simulation disagrees with the read before it.
- `changes` take the wallet's SOL and each token account's amount from the simulation's own pre and post balances (anza-xyz/agave `a64fa73`, `rpc-client-types/src/response.rs:467` to `:470`, filled by `bank.simulate_transaction` in `rpc/src/rpc.rs:3515` to `:3531`), so a transaction that lands between a read and the simulation cannot show in them. The owner, data length, delegate, allowance and close authority compare the read before the simulation with the simulation's account state, and count only when a second read after it agrees with the first. A change another transaction makes and undoes between the two reads goes unseen.
- `blocks` lists why signing waits: `"cosigner-missing"` when another required signature is missing, `"simulation-not-run"`, or `"simulation-failed"`.
- `drainPattern` is `drainPattern(summary)`, defined below.
- `simulatedAt` is `{ slot, blockhash }`, the slot from the `simulateTransaction` response context and the blockhash simulated against in place of the transaction's own (kept only when it is a 32-byte value and none of the transaction's accounts), or `null` when no simulation result is used. It sits outside the summary because a later simulation of the same bytes runs at another slot.

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
const result = await preflightTransaction(drainerBytes, { rpc, user: wallet });
```

`recordedRpc` answers from recorded data, by address, through the same JSON-RPC parsing as `jsonRpc`. The accounts take the shape `getMultipleAccounts` and `simulateTransaction` return with base64 encoding. `genesisHash` defaults to devnet's; `simulation.slot` and `simulation.replacementBlockhash` are optional and come back as `simulatedAt`.

### For the app

- `preflight(rpc, base64, user)` returns a `Preflight`, which also keeps the parsed transaction, its base64, `simulatedAt` and the wallet's token accounts by address, for the card. The app passes the connected wallet as `user`, so another wallet's transaction is refused.
- `signingAllowed(result, shownFor)` allows signing only for a ready pre-flight with no signing blocks, once the card for that transaction is on screen. With a block, including a simulation that did not run or failed, the card is shown and signing waits.
- `forSigning(result, latestBlockhash)` replaces only the recent blockhash of a transaction with no signatures.
- `toReport(result)` turns a `Preflight` into a `PreflightReport`.

### Lower level

`parseTransaction`, `messageAccounts`, `decodeInstruction`, `summarizeTransaction`, `balanceChanges`, `parseTokenAccount`, `parseLookupTable`, and base58 and base64 helpers. `src/index.ts` lists every export.

## The drain pattern

`drainPattern(report)` in `src/drain.ts` is the one definition of the drain pattern, the first condition of D-05's auto-escalation threshold. E-11's threshold, E-15's claims table and the app's card read it; the card's "hands over control" flag uses the same `handsOverControl`. D-05 names the condition without defining it; the owner adopted this definition as written, its false alarms kept (ruling 7a). A ready report shows a drain pattern when, for the user's wallet (the fee payer, written `"user"`), any of these holds:

1. **Control handed over, in the decoded instructions:** a delegate other than the wallet approved over one of the wallet's token accounts; the wallet account assigned to a program other than the System Program; a token account or mint authority moved to an address other than the wallet; or a token account closed with its SOL sent to an address other than the wallet.
2. **Control handed over, in a simulation that ran without an error:** the wallet account given a new owner program or a different data length; or a token account the wallet owned given a new delegate other than the wallet, a raised allowance for a delegate other than the wallet, a new owner other than the wallet, or a new close authority other than the wallet.
3. **A sweep, in a simulation that ran without an error:** the wallet, or a token account the wallet owned, left with less than a tenth of what it held. A closed token account counts as left with nothing.

A request whose fee payer is unset is checked as rebuilt with the wallet as fee payer. A malformed transaction, a stop at a non-devnet endpoint, another wallet's transaction, and a run with no wallet named never show a drain pattern. A simulation that failed, or one whose result is not used, shows one only when the decoded instructions hand over control; a result not used holds signing. The tenth is `SWEEP_DIVISOR`. The definition reads both the decoded instructions and the simulation: a stored drainer re-simulated after the wallet was already emptied can fail, and its instructions still show what it asked for.

What the definition does not look at: where the SOL or tokens go. A payment to the event organizer of a whole token balance, or of more than nine tenths of the wallet's SOL, shows a drain pattern; so does unwrapping wrapped SOL back to the wallet, which closes a token account that held a balance. `src/review.test.ts` holds the cases.

## Using it from Node

Node 24 runs the package's TypeScript directly. The workspace link `node_modules/@limen/preflight` resolves to `packages/preflight`, outside `node_modules`, so Node strips its types. Imports inside the package carry the `.ts` extension.

## Tests

```bash
npm test --workspace @limen/preflight
```

The script typechecks the package with no Node or DOM types, typechecks the tests with Node types, then runs `node --test` on `src/**/*.test.ts`. The fixtures are in `fixtures/tx/`, built by `fixtures/tx/generate-e09.mjs` with `@solana/web3.js` 1.99.0 and `@solana/spl-token` 0.4.15, which are dev dependencies of this package only. `src/crosscheck.test.ts` checks the parser, the account order and the decoder against those libraries on seeded random inputs. `src/summary.test.ts` owes `truncated` for every strict prefix of every fixture and owes web3.js's reading for every damaged copy the parser accepts; its 20000-input run is crash coverage only. `src/audit.test.ts` and `src/audit-sim.test.ts` hold the cases from the owner's Codex audit of E-09.

## Sources

Layouts and rules come from the program sources at pinned commits, named at the top of each file: anza-xyz/solana-sdk `7b382f6`, solana-program/token `38de8d1`, solana-program/token-2022 `efe55b4`, solana-program/associated-token-account `34509e4`, anza-xyz/agave `a64fa73` for the priority fee (`src/fee.ts`) and the simulation's own balances, and the Solana Pay specification at solana-foundation/pay `8e1b87c`.

## Not verified

- Other signers' signatures are not checked cryptographically; `signatureFilled` says only that a slot is not empty.
- No funded transaction has been simulated against devnet.
- With no `SetComputeUnitLimit`, the priority fee effect gives the most the fee can be, at 1400000 units; limen does not work out the runtime's default limit, which depends on the instructions and the cluster's feature set.
