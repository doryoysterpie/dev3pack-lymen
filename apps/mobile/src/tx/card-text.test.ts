import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  decodePublicKey,
  FROM_READ_BEFORE,
  preflight,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  type Fetch,
} from "@limen/preflight";

// Test support from the package, not one of its exports.
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
          "Your wallet pays a priority fee of up to 0.00007 SOL: 50000 micro-lamports per compute unit, for the runtime's default number of units, at most 1400000.",
      },
      {
        label: "Sends SOL",
        value: `4.99 SOL from your wallet to ${attacker}.`,
      },
      {
        label: "Approves a delegate",
        value: `${attacker} may move up to 18446744073709551615 base units, the largest allowance a token account can hold, from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
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
  it("says when the simulation gives the wallet a new owner program", async () => {
    const rpc = recordedEndpoint({
      accounts: {
        [fixture.user]: {
          lamports: 5_000_000_000,
          owner: SYSTEM_PROGRAM,
          data: ["", "base64"],
        },
      },
      simulation: {
        err: null,
        accounts: {
          [fixture.user]: {
            lamports: 4_999_995_000,
            owner: unknownProgram,
            data: ["", "base64"],
          },
        },
      },
    });
    const result = await preflight(
      rpc,
      transactionOf("unknown program"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Your wallet, simulated" &&
          row.value ===
            `5 SOL before, 4.999995 SOL after. Your wallet account's owner program: ${SYSTEM_PROGRAM} in a read taken before the simulation, ${unknownProgram} after it, which would then control its SOL.`,
      ),
    );
  });

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
      `${lead} The simulation ran, and the balance changes it found are shown below.`,
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
      simulation: {
        status: "ran" as const,
        err: null,
        changes: [],
        fromReadBefore: FROM_READ_BEFORE,
      },
      blocks: [],
    };
    const card = transactionCardText(LINK, null, closeOnly);
    assert.equal(card.tone, "neutral");
    assert.equal(
      card.status,
      "This card shows the changes limen simulated to your wallet's SOL, owner program and data, and to the token amount, delegate, owner and close authority of each token account a read shows your wallet owns. Other changes, such as SOL sent to a token account by another signer, may not be shown.",
    );
    assert.deepEqual(card.rows[1], {
      label: "Closes a token account",
      value: `It asks to close ${userTokenAccount} and send its SOL to your wallet.`,
    });
  });

  it("m12: names an address from a lookup table limen could not read", async () => {
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
            `4.99 SOL from your wallet to an address in lookup table ${fixture.keys.lookupTable} (index 1) that limen could not read.`,
      ),
    );
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Lookup tables" &&
          row.value ===
            "1 address comes from a lookup table limen could not read.",
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
    assert.equal(card.title, "Stopped: no wallet");
    assert.equal(card.tone, "flagged");
    assert.equal(
      card.status,
      "limen holds this transaction: no wallet is connected, and limen pre-flights a transaction only for the wallet that pays its fee.",
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
        "Your wallet pays a priority fee of 4.9 SOL: 3500000000 micro-lamports per compute unit for 1400000 units.",
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
      value: `1000000000000000 base units of mint ${fixture.keys.mint} to token account ${attacker}. Your wallet signs as the mint authority the instruction names.`,
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
          accounts: {
            [fixture.user]: walletAccount(4_999_995_000, unknownProgram),
          },
        },
      }),
      transactionOf("unknown program"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.equal(
      card.status,
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation ran, and the balance changes it found are shown below. As simulated, your wallet or one of its token accounts would be left with less than a tenth of what it held, or, compared with a read taken before the simulation, would come under another address's control or hold a different amount of data.",
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
    });
    assert.equal(
      card.status,
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. No simulation result is used, so no balance change is shown. It asks your wallet to give another address control of tokens or accounts.",
    );
  });

  it("starts the delegate row with a capital when the delegate is the wallet", async () => {
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
    });
    assert.deepEqual(card.rows[1], {
      label: "Approves a delegate",
      value: `Your wallet may move up to 5 base units from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
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
      value: `${LOWER} may move up to 5 base units from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
    });
  });

  it("N4: a delegate in a lookup table limen could not read starts the sentence, its table address as written", async () => {
    const rows = await rowsFor([
      { ...approve(attacker, "5"), delegate: { table: LOWER, index: 0 } },
    ]);
    assert.deepEqual(rows[1], {
      label: "Approves a delegate",
      value: `An address in lookup table ${LOWER} (index 0) that limen could not read may move up to 5 base units from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
    });
  });

  it("A8: says your token account only when a read shows the wallet owns it", async () => {
    const tokenData = new Uint8Array(165);
    tokenData.set(decodePublicKey(fixture.keys.mint) ?? new Uint8Array(32), 0);
    tokenData.set(decodePublicKey(fixture.user) ?? new Uint8Array(32), 32);
    tokenData[64] = 200;
    tokenData[108] = 1;
    const result = await preflight(
      recordedEndpoint({
        accounts: {
          [fixture.user]: {
            lamports: 5_000_000_000,
            owner: SYSTEM_PROGRAM,
            data: ["", "base64"],
          },
          [userTokenAccount]: {
            lamports: 2_039_280,
            owner: TOKEN_PROGRAM,
            data: [Buffer.from(tokenData).toString("base64"), "base64"],
          },
        },
        simulation: { err: null, accounts: {} },
      }),
      transactionOf("drainer: SOL balance out"),
      fixture.user,
    );
    assert.ok(result.kind === "ready");
    assert.deepEqual(result.userTokenAccounts, [userTokenAccount]);
    const card = transactionCardText(LINK, null, result);
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "Approves a delegate" &&
          row.value ===
            `${attacker} may move up to 18446744073709551615 base units, the largest allowance a token account can hold, from your token account ${userTokenAccount}.`,
      ),
    );
  });

  it("1: the largest allowance is not called unlimited", async () => {
    const rows = await rowsFor([approve(attacker, U64)]);
    assert.deepEqual(rows[1], {
      label: "Approves a delegate",
      value: `${attacker} may move up to ${U64} base units, the largest allowance a token account can hold, from token account ${userTokenAccount}. Your wallet signs as the owner the instruction names.`,
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
    ]);
    assert.deepEqual(rows.slice(1, 9), [
      {
        label: "Pays to create an account",
        value: `It asks your wallet to pay 0.005 SOL into new account ${attacker}.`,
      },
      {
        label: "Hands over your wallet account",
        value: `It asks to assign your wallet account to program ${unknownProgram}, which would then control its SOL.`,
      },
      {
        label: "Changes an authority",
        value: `It asks to set no close authority on ${userTokenAccount}. If accepted, the account's owner can still close it.`,
      },
      {
        label: "Changes an authority",
        value: `It asks to set no mint authority on ${userTokenAccount}.`,
      },
      {
        label: "Changes an authority",
        value: `It asks to set no TransferFeeConfig authority on ${userTokenAccount}.`,
      },
      {
        label: "Changes an authority",
        value: `It asks to set the freeze authority of ${userTokenAccount} to ${attacker}.`,
      },
      {
        label: "Changes an authority",
        value: `It asks to set the TransferFeeConfig authority of ${userTokenAccount} to ${attacker}.`,
      },
      {
        label: "Closes a token account",
        value: `It asks to close ${userTokenAccount} and send its SOL to ${attacker}.`,
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
        (row) => row.value === "It asks to advance a durable nonce.",
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

  it("A7: a transfer from a token account to itself moves no tokens", async () => {
    const rows = await rowsFor([
      {
        kind: "token-out" as const,
        instruction: 0,
        program: "token" as const,
        source: { address: userTokenAccount },
        destination: { address: userTokenAccount },
        mint: null,
        amount: "5",
        decimals: null,
      },
    ]);
    assert.deepEqual(rows[1], {
      label: "Transfers to the same account",
      value: `It asks to transfer 5 base units from token account ${userTokenAccount} to itself, which moves no tokens if accepted.`,
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
        value: `From token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
      {
        label: "Burns tokens",
        value: `5 base units from token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
    ]);
  });

  it("A9: a change in the wallet's data length alone is named in the headline", async () => {
    const wallet = (lamports: number, length: number) => ({
      lamports,
      owner: SYSTEM_PROGRAM,
      data: [Buffer.alloc(length).toString("base64"), "base64"] as const,
    });
    const result = await preflight(
      recordedEndpoint({
        accounts: { [fixture.user]: wallet(5_000_000_000, 0) },
        simulation: {
          err: null,
          accounts: { [fixture.user]: wallet(4_990_000_000, 64) },
        },
      }),
      transactionOf("unknown program"),
      fixture.user,
    );
    const card = transactionCardText(LINK, null, result);
    assert.equal(
      card.status,
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation ran, and the balance changes it found are shown below. As simulated, your wallet or one of its token accounts would be left with less than a tenth of what it held, or, compared with a read taken before the simulation, would come under another address's control or hold a different amount of data.",
    );
  });

  it("10: a decoded hand-over with a failed run says the run failed", async () => {
    const result = await drainerOffline();
    const failed = {
      status: "ran" as const,
      err: { InstructionError: [1, "Custom"] },
      changes: [],
      fromReadBefore: FROM_READ_BEFORE,
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

  it("A2: each change row says which values come from a read before the simulation", async () => {
    const result = await drainerOffline();
    const token = (change: Record<string, unknown>) => ({
      kind: "token" as const,
      account: userTokenAccount,
      mint: fixture.keys.mint,
      before: "200",
      after: "200",
      delegateBefore: null,
      delegateAfter: null,
      delegatedAmountBefore: "0",
      delegatedAmountAfter: "0",
      ownerAfter: "user",
      closeAuthorityBefore: null,
      closeAuthorityAfter: null,
      ...change,
    });
    const card = transactionCardText(LINK, null, {
      ...result,
      simulation: {
        status: "ran" as const,
        err: null,
        fromReadBefore: FROM_READ_BEFORE,
        changes: [
          {
            kind: "sol" as const,
            account: "user",
            before: "5000000000",
            after: "4990000000",
            ownerBefore: SYSTEM_PROGRAM,
            ownerAfter: SYSTEM_PROGRAM,
            dataLengthBefore: 0,
            dataLengthAfter: 64,
          },
          token({
            delegateAfter: attacker,
            delegatedAmountAfter: "100",
            closeAuthorityAfter: attacker,
          }),
          token({
            delegateBefore: attacker,
            delegateAfter: attacker,
            delegatedAmountBefore: "5",
            delegatedAmountAfter: "100",
          }),
          token({
            delegateBefore: attacker,
            delegatedAmountBefore: "5",
            closeAuthorityBefore: attacker,
          }),
        ],
      },
      blocks: [],
    });
    const simulated = card.rows.filter((row) =>
      row.label.endsWith("simulated"),
    );
    assert.deepEqual(simulated, [
      {
        label: "Your wallet, simulated",
        value:
          "5 SOL before, 4.99 SOL after. Your wallet account's data: 0 bytes in a read taken before the simulation, 64 bytes after it.",
      },
      {
        label: `Your token account ${userTokenAccount}, simulated`,
        value: `200 base units before, 200 after. The delegate: none in a read taken before the simulation, ${attacker} after it, for up to 100 base units. The close authority: none in a read taken before the simulation, ${attacker} after it.`,
      },
      {
        label: `Your token account ${userTokenAccount}, simulated`,
        value: `200 base units before, 200 after. The allowance of delegate ${attacker}: 5 base units in a read taken before the simulation, 100 base units after it.`,
      },
      {
        label: `Your token account ${userTokenAccount}, simulated`,
        value: `200 base units before, 200 after. The delegate: ${attacker} in a read taken before the simulation, none after it. The close authority: ${attacker} in a read taken before the simulation, none after it.`,
      },
    ]);
  });

  it("hunt: a row the token program always refuses says it would fail", async () => {
    const rows = await rowsFor([
      {
        kind: "authority-changed" as const,
        instruction: 0,
        program: "token" as const,
        account: { address: userTokenAccount },
        authorityType: "AccountOwner",
        newAuthority: null,
      },
      {
        kind: "account-closed" as const,
        instruction: 1,
        program: "token-2022" as const,
        account: { address: userTokenAccount },
        destination: { address: userTokenAccount },
      },
    ]);
    assert.deepEqual(rows.slice(1, 3), [
      {
        label: "Refused by the token program",
        value: `It asks to remove the owner of token account ${userTokenAccount}, which the Token program refuses, so the transaction would fail.`,
      },
      {
        label: "Refused by the token program",
        value: `It asks to close token account ${userTokenAccount} and send its SOL to that same account, which Token-2022 refuses, so the transaction would fail.`,
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
        value: `It asks to set the owner of ${userTokenAccount} to your wallet.`,
      },
      {
        label: "Changes an authority",
        value: `It asks to set the mint authority of ${fixture.keys.mint} to ${attacker}.`,
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
      value:
        "An instruction that does not name your wallet as its payer or authority. Your wallet's signature may still count toward it, for example as one signer of a multisig.",
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
      assert.equal(
        transactionCardText(LINK, null, { kind: "malformed", problem }).status,
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
    assert.deepEqual(result.userTokenAccounts, [userTokenAccount]);
    const card = transactionCardText(LINK, null, result);
    assert.equal(card.tone, "neutral");
    assert.equal(
      card.status,
      "This card shows the changes limen simulated to your wallet's SOL, owner program and data, and to the token amount, delegate, owner and close authority of each token account a read shows your wallet owns. Other changes, such as SOL sent to a token account by another signer, may not be shown.",
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
        value: `5 base units from token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
      {
        label: "Removes any delegate",
        value: `From token account ${userTokenAccount}. Your wallet signs as the authority the instruction names.`,
      },
      {
        label: "Creates a token account",
        value: `It asks your wallet to pay up to the rent for new token account ${attacker}.`,
      },
      {
        label: "May create a token account",
        value: `It asks to create token account ${attacker} if it does not exist yet, with your wallet paying up to its rent.`,
      },
    ]);
  });
});
