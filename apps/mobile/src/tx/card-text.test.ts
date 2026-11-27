import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { jsonRpc, preflight, type Fetch } from "@limen/preflight";

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
    assert.deepEqual(card.rows.slice(0, 3), [
      { label: "Requested from", value: "pay.example" },
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
            `Instruction 2 calls ${unknownProgram}, with a program limen does not decode.`,
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
