import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import {
  decodePublicKey,
  preflight,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  type Fetch,
} from "@limen/preflight";

// Test support from the package, not one of its exports.
import { legacy } from "../../../../packages/preflight/test-support/build.ts";
import {
  endpointFor,
  recordedEndpoint,
} from "../../../../packages/preflight/test-support/recorded.ts";

import { linkHost, transactionCardText, withDecimals } from "./card-text.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly cases: readonly {
    readonly name: string;
    readonly transaction: string;
  }[];
};

const transactionOf = (start: string): string => {
  const found = fixture.cases.find((c) => c.name.startsWith(start));
  assert.ok(found, start);
  return found.transaction;
};

const LINK = "https://pay.example/solana-pay?order=7";
const { attacker, userTokenAccount, unknownProgram } = fixture.keys;

// The RPC is unreachable, so these cards come from the decode alone.
const unreachable: Fetch = async () => {
  throw new Error("offline");
};
const offline = endpointFor(unreachable, "https://devnet.example");

describe("E-09 done test: what the transaction card shows", () => {
  it("shows the drainer's SOL balance out and the delegate approved, flagged", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.equal(card.title, "Solana Pay transaction request");
    assert.equal(card.tone, "flagged");
    assert.equal(
      card.status,
      "limen flags this transaction: it asks your wallet to give another address control of tokens or accounts.",
    );
    assert.deepEqual(card.rows.slice(0, 4), [
      { label: "Requested from", value: "pay.example" },
      {
        label: "Pays a priority fee",
        value:
          "Asks your wallet to pay a priority fee of up to 0.00007 SOL: 50000 micro-lamports per compute unit, for the runtime's default number of units, at most 1400000.",
      },
      {
        label: "Sends SOL",
        value: `Asks to send 4.99 SOL from your wallet to ${attacker}.`,
      },
      {
        label: "Approves a delegate",
        value: `Asks to let ${attacker} move up to 18446744073709551615 base units, the largest allowance a token account can hold, from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
      },
    ]);
  });

  it("states that limen pre-flights only transactions your wallet pays for", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Fee payer" &&
          row.value ===
            "Your wallet. limen pre-flights only transactions your wallet pays the fee for.",
      ),
    );
    assert.equal(JSON.stringify(card).includes(fixture.user), false);
  });

  it("shows the fallback card for an unknown program, not a crash", async () => {
    const result = await preflight(
      offline,
      transactionOf("unknown program"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.equal(
      card.title,
      "Fallback: limen cannot decode all of this transaction",
    );
    assert.equal(card.tone, "flagged");
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Not decoded" &&
          row.value ===
            `Instruction 2 calls ${unknownProgram}, a program limen does not decode.`,
      ),
    );
  });
});

describe("transaction card text", () => {
  it("stops when the connected wallet is not the transaction's fee payer", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      attacker,
    );
    const card = transactionCardText(LINK, null, result);
    assert.equal(card.title, "Stopped: not your wallet's transaction");
    assert.equal(card.tone, "flagged");
    assert.deepEqual(card.rows[1], { label: "Fee payer", value: fixture.user });
  });

  it("quotes the requester's message on one line, apart", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    const card = transactionCardText(
      LINK,
      "Thanks\nOrganizer: this recipient is on the organizer list.",
      result,
    );
    assert.deepEqual(card.rows[1], {
      label: "Message, as written by the requester",
      value:
        '"Thanks\\u{000A}Organizer: this recipient is on the organizer list."',
      quoted: true,
    });
  });

  it("m4: the fallback card says how far the simulation ran", async () => {
    const lead =
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do.";
    const walletAccount = (lamports: number) => ({
      lamports,
      owner: SYSTEM_PROGRAM,
      data: ["", "base64"] as const,
    });
    const statusWith = async (rpc: Parameters<typeof preflight>[0]) =>
      transactionCardText(
        LINK,
        null,
        await preflight(rpc, transactionOf("unknown program"), fixture.user),
      ).status;
    assert.equal(
      await statusWith(offline),
      `${lead} No simulation result is used, so no balance change is shown.`,
    );
    assert.equal(
      await statusWith(
        recordedEndpoint({
          accounts: { [fixture.user]: walletAccount(5_000_000_000) },
          simulation: {
            err: null,
            accounts: { [fixture.user]: walletAccount(4_999_995_000) },
          },
        }),
      ),
      `${lead} The simulation ran, and any change it found to your wallet's SOL is shown below.`,
    );
    assert.equal(
      await statusWith(
        recordedEndpoint({
          accounts: { [fixture.user]: walletAccount(5_000_000_000) },
          simulation: {
            err: { InstructionError: [1, "Custom"] },
            accounts: {},
          },
        }),
      ),
      `${lead} The simulation failed, so no balance change is shown.`,
    );
  });

  it("m5: a token account closed back to the wallet is not flagged", async () => {
    const ran = await preflight(
      recordedEndpoint({
        accounts: {},
        simulation: { err: null, accounts: {} },
      }),
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    assert.ok(ran.kind === "ready");
    const closeOnly = {
      ...ran,
      summary: {
        ...ran.summary,
        effects: [
          {
            kind: "account-closed" as const,
            instruction: 0,
            program: "token" as const,
            account: { address: userTokenAccount },
            destination: { address: "user" },
          },
        ],
      },
      // The verdict effect.ts gives a close to the wallet.
      verdicts: [{ instruction: 0, verdict: "other" as const }],
      simulation: {
        status: "ran" as const,
        err: null,
        changes: [],
      },
      blocks: [],
    };
    const card = transactionCardText(LINK, null, closeOnly);
    assert.equal(card.tone, "neutral");
    assert.equal(
      card.status,
      "As simulated, your wallet's SOL balance stays the same. Other simulated changes, such as tokens moved or SOL sent to a token account by another signer, are not shown.",
    );
    assert.deepEqual(card.rows[1], {
      label: "Closes a token account",
      value: `Asks to close ${userTokenAccount} and send its SOL to your wallet.`,
    });
  });

  it("the audit of 21e1f9f, item 9: the fallback card says when the wallet's SOL stays the same", async () => {
    const walletAccount = {
      lamports: 5_000_000_000,
      owner: SYSTEM_PROGRAM,
      data: ["", "base64"] as const,
    };
    const result = await preflight(
      recordedEndpoint({
        accounts: { [fixture.user]: walletAccount },
        simulation: { err: null, accounts: {} },
      }),
      transactionOf("unknown program"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    assert.ok(result.simulation.status === "ran");
    assert.deepEqual(result.simulation.changes, []);
    assert.equal(
      transactionCardText(LINK, null, result).status,
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation ran, and your wallet's SOL balance stays the same.",
    );
  });

  it("m12: names an address from a lookup table limen does not show", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer as a v0 transaction, lookup table not loaded"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Sends SOL" &&
          row.value ===
            `Asks to send 4.99 SOL from your wallet to an address in lookup table ${fixture.keys.lookupTable} (index 1) that limen does not show.`,
      ),
    );
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Lookup tables" &&
          row.value ===
            "1 address comes from a lookup table. limen shows an address from a lookup table only with a simulation result it uses, so this one is not shown.",
      ),
    );
  });

  it("m13: says when limen set the wallet as fee payer", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    const card = transactionCardText(LINK, null, {
      ...result,
      feePayerSet: true,
    });
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Fee payer" &&
          row.value ===
            "Your wallet. The request left the fee payer unset, so limen set your wallet, as the Solana Pay specification has the wallet do. limen pre-flights only transactions your wallet pays the fee for.",
      ),
    );
  });

  it("n3: stops when no wallet is given", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      undefined as unknown as string,
    );
    assert.deepEqual(result, { kind: "user-not-given" });
    const card = transactionCardText(LINK, null, result);
    // limen was given no wallet address; it cannot tell that none is
    // connected (the audit of 6c4e64e, Major 9).
    assert.equal(card.title, "Stopped: no readable wallet address");
    assert.equal(card.tone, "flagged");
    assert.equal(
      card.status,
      "limen holds this transaction: it was given no wallet address it can read, and limen pre-flights a transaction only for the wallet that pays its fee.",
    );
  });

  it("m6: shows a set priority fee in SOL", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    const card = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        effects: [
          {
            kind: "priority-fee" as const,
            instruction: 1,
            microLamportsPerUnit: "3500000000",
            unitLimit: 1_400_000,
            lamports: "4900000000",
          },
        ],
      },
    });
    assert.deepEqual(card.rows[1], {
      label: "Pays a priority fee",
      value:
        "Asks your wallet to pay a priority fee of 4.9 SOL: 3500000000 micro-lamports per compute unit for 1400000 units.",
    });
  });

  it("m7: shows tokens minted, signed by the wallet as the mint authority the instruction names", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    const card = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        effects: [
          {
            kind: "tokens-minted" as const,
            instruction: 0,
            program: "token" as const,
            mint: { address: fixture.keys.mint },
            destination: { address: attacker },
            amount: "1000000000000000",
            decimals: null,
          },
        ],
      },
    });
    assert.deepEqual(card.rows[1], {
      label: "Mints tokens",
      value: `Asks to mint 1000000000000000 base units of mint ${fixture.keys.mint} to token account ${attacker}. Your wallet signs as the mint authority the instruction names.`,
    });
  });

  it("n1: the fallback card says when the simulation found a drain pattern", async () => {
    const walletAccount = (lamports: number, owner: string) => ({
      lamports,
      owner,
      data: ["", "base64"] as const,
    });
    const result = await preflight(
      recordedEndpoint({
        accounts: {
          [fixture.user]: walletAccount(5_000_000_000, SYSTEM_PROGRAM),
        },
        simulation: {
          err: null,
          // Ruling 20a: the drain pattern a run shows is the wallet's SOL
          // sweep, from the run's own balances.
          accounts: {
            [fixture.user]: walletAccount(400_000_000, SYSTEM_PROGRAM),
          },
        },
      }),
      transactionOf("unknown program"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.equal(
      card.status,
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation ran, and any change it found to your wallet's SOL is shown below. As simulated, your wallet would be left with less than a tenth of the SOL it held.",
    );
  });

  it("n1: the fallback card says when a decoded instruction hands over control", async () => {
    const result = await preflight(
      offline,
      transactionOf("unknown program"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    const card = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        effects: [
          {
            kind: "delegate-approved" as const,
            instruction: 0,
            program: "token" as const,
            account: { address: userTokenAccount },
            delegate: { address: attacker },
            mint: null,
            amount: "5",
            decimals: null,
          },
        ],
      },
      // The verdict effect.ts gives this approval (effect.test.ts).
      verdicts: [{ instruction: 0, verdict: "hands-over" as const }],
    });
    assert.equal(
      card.status,
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. No simulation result is used, so no balance change is shown. It asks your wallet to give another address control of tokens or accounts.",
    );
  });

  it("names the wallet as the delegate inside the row's sentence", async () => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    const card = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        effects: [
          {
            kind: "delegate-approved" as const,
            instruction: 0,
            program: "token" as const,
            account: { address: userTokenAccount },
            delegate: { address: "user" },
            mint: null,
            amount: "5",
            decimals: null,
          },
        ],
      },
      // The verdict effect.ts gives an approval to the wallet itself.
      verdicts: [{ instruction: 0, verdict: "other" as const }],
    });
    assert.deepEqual(card.rows[1], {
      label: "Approves a delegate",
      value: `Asks to let your wallet move up to 5 base units from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
    });
    assert.equal(
      card.status,
      "This card shows what the decoded instructions ask for. No simulation result is used, so no balance change is shown.",
    );
  });

  it("stops with its own card when the endpoint is not devnet", () => {
    const card = transactionCardText(LINK, null, { kind: "not-devnet" });
    assert.equal(card.title, "Stopped: not devnet");
    assert.equal(card.tone, "flagged");
  });

  it("formats base units with decimals", () => {
    assert.equal(withDecimals("4990000000", 9), "4.99");
    assert.equal(withDecimals("1", 9), "0.000000001");
    assert.equal(withDecimals("1000000000", 9), "1");
    assert.equal(withDecimals("2500000", 6), "2.5");
    assert.equal(withDecimals("0", 6), "0");
    assert.equal(withDecimals("17", 0), "17");
  });
});

describe("the owner's audit: what the card claims", () => {
  // A valid address that starts with a lowercase base58 letter.
  const LOWER = "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN";
  const U64 = "18446744073709551615";
  type Ready = Extract<
    Awaited<ReturnType<typeof preflight>>,
    { kind: "ready" }
  >;
  const drainerOffline = async (): Promise<Ready> => {
    const result = await preflight(
      offline,
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    return result;
  };
  const rowsFor = async (effects: Ready["summary"]["effects"]) => {
    const result = await drainerOffline();
    return transactionCardText(LINK, null, {
      ...result,
      summary: { ...result.summary, effects },
    }).rows;
  };
  const approve = (delegate: string, amount: string) => ({
    kind: "delegate-approved" as const,
    instruction: 0,
    program: "token" as const,
    account: { address: userTokenAccount },
    delegate: { address: delegate },
    mint: null,
    amount,
    decimals: null,
  });

  it("1: shows a delegate's address exactly as written", async () => {
    const rows = await rowsFor([approve(LOWER, "5")]);
    assert.deepEqual(rows[1], {
      label: "Approves a delegate",
      value: `Asks to let ${LOWER} move up to 5 base units from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
    });
  });

  it("N4: names a delegate in a lookup table limen does not show, its table address as written", async () => {
    const rows = await rowsFor([
      { ...approve(attacker, "5"), delegate: { table: LOWER, index: 0 } },
    ]);
    assert.deepEqual(rows[1], {
      label: "Approves a delegate",
      value: `Asks to let an address in lookup table ${LOWER} (index 0) that limen does not show move up to 5 base units from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
    });
  });

  it("1: the largest allowance is not called unlimited", async () => {
    const rows = await rowsFor([approve(attacker, U64)]);
    assert.deepEqual(rows[1], {
      label: "Approves a delegate",
      value: `Asks to let ${attacker} move up to ${U64} base units, the largest allowance a token account can hold, from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
    });
  });

  it("10: a decoded card whose simulation is not used says so", async () => {
    const result = await drainerOffline();
    const card = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        effects: [
          {
            kind: "sol-out" as const,
            instruction: 0,
            to: { address: attacker },
            lamports: "1000",
            reason: "transfer" as const,
          },
        ],
      },
      // The verdict effect.ts gives a SOL transfer.
      verdicts: [{ instruction: 0, verdict: "other" as const }],
    });
    assert.equal(
      card.status,
      "This card shows what the decoded instructions ask for. No simulation result is used, so no balance change is shown.",
    );
  });

  it("10: a failed simulation shows no balance change rows", async () => {
    const walletAccount = (lamports: number) => ({
      lamports,
      owner: SYSTEM_PROGRAM,
      data: ["", "base64"] as const,
    });
    const result = await preflight(
      recordedEndpoint({
        accounts: { [fixture.user]: walletAccount(5_000_000_000) },
        simulation: {
          err: { InstructionError: [1, "Custom"] },
          accounts: { [fixture.user]: walletAccount(1_000_000_000) },
        },
      }),
      transactionOf("unknown program"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.equal(
      card.rows.some((row) => row.label.endsWith("simulated")),
      false,
    );
    assert.ok(
      card.status.endsWith(
        "The simulation failed, so no balance change is shown.",
      ),
    );
  });

  it("re-audit 2, item 5: each row says what an instruction asks, not what happens", async () => {
    const authority = (
      instruction: number,
      authorityType: string,
      newAuthority: string | null,
    ) => ({
      kind: "authority-changed" as const,
      instruction,
      program: "token-2022" as const,
      account: { address: userTokenAccount },
      authorityType,
      newAuthority,
    });
    const rows = await rowsFor([
      {
        kind: "sol-out" as const,
        instruction: 0,
        to: { address: attacker },
        lamports: "5000000",
        reason: "create-account" as const,
      },
      {
        kind: "owner-assigned" as const,
        instruction: 1,
        newOwner: unknownProgram,
      },
      authority(2, "CloseAccount", null),
      authority(3, "MintTokens", null),
      authority(4, "TransferFeeConfig", null),
      authority(5, "FreezeAccount", attacker),
      authority(6, "TransferFeeConfig", attacker),
      {
        kind: "account-closed" as const,
        instruction: 7,
        program: "token-2022" as const,
        account: { address: userTokenAccount },
        destination: { address: attacker },
      },
      {
        kind: "token-out" as const,
        instruction: 8,
        program: "token" as const,
        source: { address: userTokenAccount },
        destination: { address: attacker },
        mint: { address: fixture.keys.mint },
        amount: "2500000",
        decimals: 6,
      },
      {
        kind: "sol-out" as const,
        instruction: 9,
        to: { address: attacker },
        lamports: "1000000000",
        reason: "derived-account" as const,
      },
    ]);
    // Every row a decoded effect makes says what the instruction asks.
    for (const row of rows.slice(1, 11)) {
      assert.ok(row.value.startsWith("Asks "), row.value);
    }
    assert.deepEqual(rows.slice(9, 11), [
      {
        label: "Sends tokens",
        // Base units and the decimals the instruction states, no derived
        // quantity (the audit of 6c4e64e, Major 8).
        value: `Asks to send 2500000 base units (the instruction expects a mint with 6 decimals) of mint ${fixture.keys.mint} from token account ${userTokenAccount} to ${attacker}.`,
      },
      {
        label: "Sends SOL",
        value: `Asks to send 1 SOL from an account derived from your wallet to ${attacker}.`,
      },
    ]);
    assert.deepEqual(rows.slice(1, 9), [
      {
        label: "Pays to create an account",
        value: `Asks your wallet to pay 0.005 SOL into new account ${attacker}.`,
      },
      {
        label: "Hands over your wallet account",
        value: `Asks to assign your wallet account to program ${unknownProgram}, which would then control its SOL.`,
      },
      {
        label: "Changes an authority",
        value: `Asks to set no close authority on ${userTokenAccount}.`,
      },
      {
        label: "Changes an authority",
        value: `Asks to set no mint authority on ${userTokenAccount}.`,
      },
      {
        label: "Changes an authority",
        value: `Asks to set no TransferFeeConfig authority on ${userTokenAccount}.`,
      },
      {
        label: "Changes an authority",
        value: `Asks to set the freeze authority of ${userTokenAccount} to ${attacker}.`,
      },
      {
        label: "Changes an authority",
        value: `Asks to set the TransferFeeConfig authority of ${userTokenAccount} to ${attacker}.`,
      },
      {
        label: "Closes a token account",
        value: `Asks to close ${userTokenAccount} and send its SOL to ${attacker}.`,
      },
    ]);
    const result = await drainerOffline();
    const nonce = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        effects: [],
        others: [{ instruction: 0, kind: "advance-nonce" as const }],
      },
    });
    assert.ok(
      nonce.rows.some(
        (row) => row.value === "Asks to advance a durable nonce.",
      ),
    );
    // No row says an instruction is accepted, removes something, or happens.
    for (const row of [...rows, ...nonce.rows]) {
      assert.doesNotMatch(
        row.value,
        /\baccepts\b|\bis removed\b|\bmoves to\b/,
        row.value,
      );
    }
  });

  it("the audit of 21e1f9f, item 8: names the wallet's own address as the new owner", async () => {
    const rows = await rowsFor([
      { kind: "owner-assigned" as const, instruction: 0, newOwner: "user" },
    ]);
    assert.deepEqual(rows[1], {
      label: "Assigns your wallet account",
      value:
        "Asks to make your wallet's own address the owner program of your wallet account.",
    });
  });

  it("A7: a transfer from a token account to itself moves no tokens", async () => {
    // A real transaction, so the row reads effect.ts's verdict.
    const card = transactionCardText(
      LINK,
      null,
      await preflight(
        offline,
        legacy(
          fixture.user,
          [
            spl.createTransferInstruction(
              new web3.PublicKey(userTokenAccount),
              new web3.PublicKey(userTokenAccount),
              new web3.PublicKey(fixture.user),
              5,
            ),
          ],
          fixture.keys.mint,
        ),
        fixture.user,
      ),
    );
    assert.deepEqual(card.rows[1], {
      label: "Transfers to the same account",
      value: `Asks to transfer 5 base units from token account ${userTokenAccount} to itself, which moves no tokens if accepted.`,
    });
  });

  it("A7: Revoke removes any delegate, and a burn claims only what the instruction names", async () => {
    const rows = await rowsFor([
      {
        kind: "delegate-revoked" as const,
        instruction: 0,
        program: "token" as const,
        account: { address: userTokenAccount },
      },
      {
        kind: "tokens-burned" as const,
        instruction: 1,
        program: "token" as const,
        account: { address: userTokenAccount },
        mint: { address: fixture.keys.mint },
        amount: "5",
        decimals: null,
      },
    ]);
    assert.deepEqual(rows.slice(1, 3), [
      {
        label: "Removes any delegate",
        value: `Asks to remove any delegate from token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
      {
        label: "Burns tokens",
        value: `Asks to burn 5 base units from token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
    ]);
  });

  it("10: a decoded hand-over with a failed run says the run failed", async () => {
    const result = await drainerOffline();
    const failed = {
      status: "ran" as const,
      // As failure.ts reads agave's {"InstructionError":[1,"Custom"]}.
      err: {
        transactionError: "InstructionError",
        instruction: 1,
        instructionError: null,
        custom: null,
      },
      changes: [],
    };
    const card = transactionCardText(LINK, null, {
      ...result,
      simulation: failed,
      blocks: ["simulation-failed"],
    });
    assert.equal(
      card.status,
      "limen flags this transaction: it asks your wallet to give another address control of tokens or accounts. The simulation failed, so signed now it would most likely fail.",
    );
    const fallback = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        undecoded: [
          {
            instruction: 3,
            programId: unknownProgram,
            reason: "unknown-program" as const,
          },
        ],
      },
      simulation: failed,
      blocks: ["simulation-failed"],
    });
    assert.equal(
      fallback.status,
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation failed, so no balance change is shown. It asks your wallet to give another address control of tokens or accounts.",
    );
  });

  it("hunt: a row the token program always refuses says it would fail", async () => {
    // Real instructions, so each row reads effect.ts's verdict.
    const user = new web3.PublicKey(fixture.user);
    const account = new web3.PublicKey(userTokenAccount);
    const card = transactionCardText(
      LINK,
      null,
      await preflight(
        offline,
        legacy(
          fixture.user,
          [
            spl.createSetAuthorityInstruction(
              account,
              user,
              spl.AuthorityType.AccountOwner,
              null,
            ),
            spl.createCloseAccountInstruction(account, account, user),
          ],
          fixture.keys.mint,
        ),
        fixture.user,
      ),
    );
    assert.deepEqual(card.rows.slice(1, 3), [
      {
        label: "Refused by the token program",
        value: `Asks to remove the owner of token account ${userTokenAccount}, which the Token program refuses, so the transaction would fail.`,
      },
      {
        label: "Refused by the token program",
        value: `Asks to close token account ${userTokenAccount} and send its SOL to that same account, which the Token program refuses, so the transaction would fail.`,
      },
    ]);
  });

  it("hunt: an authority set to the wallet is not said to move", async () => {
    const rows = await rowsFor([
      {
        kind: "authority-changed" as const,
        instruction: 0,
        program: "token" as const,
        account: { address: userTokenAccount },
        authorityType: "AccountOwner",
        newAuthority: "user",
      },
      {
        kind: "authority-changed" as const,
        instruction: 1,
        program: "token" as const,
        account: { address: fixture.keys.mint },
        authorityType: "MintTokens",
        newAuthority: attacker,
      },
    ]);
    assert.deepEqual(rows.slice(1, 3), [
      {
        label: "Changes an authority",
        value: `Asks to set the owner of ${userTokenAccount} to your wallet.`,
      },
      {
        label: "Changes an authority",
        value: `Asks to set the mint authority of ${fixture.keys.mint} to ${attacker}.`,
      },
    ]);
  });

  it("hunt: an instruction with no effect is not said to go unauthorized by the wallet", async () => {
    const result = await drainerOffline();
    const card = transactionCardText(LINK, null, {
      ...result,
      summary: {
        ...result.summary,
        effects: [],
        others: [{ instruction: 0, kind: "token-transfer" as const }],
      },
    });
    assert.deepEqual(card.rows[1], {
      label: "Also in the transaction",
      // Each kind gets its own row (the audit of 6c4e64e, the README Minor).
      value:
        "A token transfer that does not name your wallet as its authority. Your wallet's signature may still count toward it, for example as one signer of a multisig.",
    });
  });

  it("hunt: the card names the host the request goes to, not a user name before it", async () => {
    const result = await drainerOffline();
    for (const [link, owed] of [
      ["https://pay.example@evil.example/drainer", "evil.example"],
      [
        "https://pay.example:secret@evil.example:8443/x?y=1",
        "evil.example:8443",
      ],
      ["https://pay.example/solana-pay?order=7", "pay.example"],
    ] as const) {
      assert.equal(linkHost(link), owed, link);
      const card = transactionCardText(link, null, result);
      assert.deepEqual(card.rows[0], { label: "Requested from", value: owed });
      const stopped = transactionCardText(link, null, { kind: "not-devnet" });
      assert.deepEqual(stopped.rows[0], {
        label: "Requested from",
        value: owed,
      });
    }
  });

  it("re-audit 2, item 8: a malformed transaction's status says limen cannot read it", () => {
    for (const problem of [
      "not-base64",
      "duplicate-key",
      "bad-lookup-index",
      "truncated",
      "unsupported-version",
    ] as const) {
      const card = transactionCardText(LINK, null, {
        kind: "malformed",
        problem,
      });
      // Ruling 20a, item 7: the heading says limen cannot read it, too.
      assert.equal(card.title, "limen cannot read this transaction");
      assert.equal(
        card.status,
        `limen flags this transaction: limen cannot read it as a legacy or version 0 Solana transaction (${problem}).`,
      );
    }
  });

  it("re-audit 2, item 6: a clean card says which changes it shows, and that others may not be", async () => {
    // The audit's example: another signer, who has signed, sends SOL to the
    // wallet's token account. The wallet pays the fee. The run is clean, and
    // no row shows the SOL the token account receives.
    const other = attacker;
    const key = (address: string): Uint8Array => {
      const bytes = decodePublicKey(address);
      assert.ok(bytes !== null, address);
      return bytes;
    };
    const lamports = 5_000_000;
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true); // System Transfer
    view.setBigUint64(4, BigInt(lamports), true);
    const bytes = Uint8Array.from([
      2,
      ...new Uint8Array(64),
      ...new Uint8Array(64).fill(7),
      2, // signers: the wallet, then the other signer
      0,
      1, // the System program is read-only
      4,
      ...key(fixture.user),
      ...key(other),
      ...key(userTokenAccount),
      ...key(SYSTEM_PROGRAM),
      ...key(fixture.keys.mint), // the blockhash
      1,
      3,
      2,
      1,
      2,
      data.length,
      ...data,
    ]);
    const tokenData = new Uint8Array(165);
    tokenData.set(key(fixture.keys.mint), 0);
    tokenData.set(key(fixture.user), 32);
    tokenData[64] = 200;
    tokenData[108] = 1;
    const wallet = (amount: number) => ({
      lamports: amount,
      owner: SYSTEM_PROGRAM,
      data: ["", "base64"] as const,
    });
    const tokenAccount = (amount: number) => ({
      lamports: amount,
      owner: TOKEN_PROGRAM,
      data: [Buffer.from(tokenData).toString("base64"), "base64"] as const,
    });
    const result = await preflight(
      recordedEndpoint({
        accounts: {
          [fixture.user]: wallet(5_000_000_000),
          [other]: wallet(1_000_000_000),
          [userTokenAccount]: tokenAccount(2_039_280),
        },
        simulation: {
          err: null,
          accounts: {
            [fixture.user]: wallet(4_999_990_000),
            [other]: wallet(1_000_000_000 - lamports),
            [userTokenAccount]: tokenAccount(2_039_280 + lamports),
          },
        },
      }),
      Buffer.from(bytes).toString("base64"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    assert.equal(result.simulation.status, "ran");
    const card = transactionCardText(LINK, null, result);
    assert.equal(card.tone, "neutral");
    assert.equal(
      card.status,
      "This card shows the change limen simulated to your wallet's SOL. Other simulated changes, such as tokens moved or SOL sent to a token account by another signer, are not shown.",
    );
    // The fee is the only change shown; the token account's new SOL is not.
    assert.deepEqual(
      card.rows.filter((row) => row.label.endsWith(", simulated")),
      [
        {
          label: "Your wallet, simulated",
          value: "5 SOL before, 4.99999 SOL after.",
        },
      ],
    );
  });

  it("13: the burn, revoke and create rows claim only what the instruction proves", async () => {
    const rows = await rowsFor([
      {
        kind: "tokens-burned" as const,
        instruction: 0,
        program: "token" as const,
        account: { address: userTokenAccount },
        mint: { address: fixture.keys.mint },
        amount: "5",
        decimals: null,
      },
      {
        kind: "delegate-revoked" as const,
        instruction: 1,
        program: "token-2022" as const,
        account: { address: userTokenAccount },
      },
      {
        kind: "pays-for-token-account" as const,
        instruction: 2,
        account: { address: attacker },
        idempotent: false,
      },
      {
        kind: "pays-for-token-account" as const,
        instruction: 3,
        account: { address: attacker },
        idempotent: true,
      },
    ]);
    assert.deepEqual(rows.slice(1, 5), [
      {
        label: "Burns tokens",
        value: `Asks to burn 5 base units from token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
      {
        label: "Removes any delegate",
        value: `Asks to remove any delegate from token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
      {
        label: "Creates a token account",
        value: `Asks your wallet to pay up to the rent for new token account ${attacker}.`,
      },
      {
        label: "May create a token account",
        value: `Asks to create token account ${attacker} if it does not exist yet, with your wallet paying up to its rent.`,
      },
    ]);
  });
});
