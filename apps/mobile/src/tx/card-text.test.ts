import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  jsonRpc,
  preflight,
  recordedRpc,
  SYSTEM_PROGRAM,
  type Fetch,
} from "@limen/preflight";

import { transactionCardText, withDecimals } from "./card-text.ts";

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
const offline = jsonRpc(unreachable, "https://devnet.example");

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
      "limen flags this transaction: it would hand control of your tokens or accounts to another address.",
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
        value: `${attacker} may move every token in your token account ${userTokenAccount}, with no limit.`,
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
    const rpc = recordedRpc({
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
            `5 SOL before, 4.999995 SOL after. Your wallet account's owner program changes from ${SYSTEM_PROGRAM} to ${unknownProgram}, which would then control its SOL.`,
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
      `${lead} The simulation did not run, so no balance change is shown.`,
    );
    assert.equal(
      await statusWith(
        recordedRpc({
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
        recordedRpc({
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
      recordedRpc({
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
      simulation: { status: "ran" as const, err: null, changes: [] },
      blocks: [],
    };
    const card = transactionCardText(LINK, null, closeOnly);
    assert.equal(card.tone, "neutral");
    assert.equal(
      card.status,
      "This card shows what the transaction would do before you sign.",
    );
    assert.deepEqual(card.rows[1], {
      label: "Closes a token account",
      value: `Closes ${userTokenAccount} and sends its SOL to your wallet.`,
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

  it("m7: shows tokens minted with the wallet's mint authority", async () => {
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
      value: `Your wallet's mint authority mints 1000000000000000 base units of mint ${fixture.keys.mint} to token account ${attacker}.`,
    });
  });

  it("n1: the fallback card says when the simulation found a drain pattern", async () => {
    const walletAccount = (lamports: number, owner: string) => ({
      lamports,
      owner,
      data: ["", "base64"] as const,
    });
    const result = await preflight(
      recordedRpc({
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
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation ran, and the balance changes it found are shown below. As simulated, it would hand control of your wallet or tokens to another address, or leave your wallet or a token account with less than a tenth of what it holds.",
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
      "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation did not run, so no balance change is shown. It would hand control of your tokens or accounts to another address.",
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
      value: `Your wallet may move up to 5 base units from your token account ${userTokenAccount}.`,
    });
    assert.equal(
      card.status,
      "This card shows what the transaction would do before you sign.",
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
