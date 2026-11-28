// The owner's audit of E-09 at 6c4e64e, Majors 1, 3 and 4: every JSON-RPC
// answer is read once, by one parser, against a schema of each field limen
// reads. Each answer is a recorded answer edited as text
// (test-support/build.ts), so a case differs from a clean answer in its edit
// alone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edited, once } from "../test-support/build.ts";
import { preflight } from "./preflight.ts";
import { TOKEN_PROGRAM } from "./programs.ts";
import { latestBlockhash } from "./rpc.ts";
import {
  BLOCKHASH,
  MINT,
  USER,
  clean,
  drainer,
  loadedV0,
  notRun,
  ready,
} from "../test-support/audit.ts";

describe("the audit of 6c4e64e, Majors 1 and 4: one reader for every answer", () => {
  it("a clean recorded run is used, so each case below differs in its edit alone", async () => {
    const result = ready(await preflight(clean(), drainer, USER));
    assert.equal(result.simulation.status, "ran");
    assert.deepEqual(result.blocks, []);
    assert.equal(await latestBlockhash(clean()), BLOCKHASH);
    const v0 = ready(await preflight(clean(), loadedV0.transaction, USER));
    assert.equal(v0.simulation.status, "ran");
  });

  // Major 1: a repeated member name, at any depth, makes an answer limen
  // does not read, whichever value JSON.parse would keep.
  for (const [method, find, replace] of [
    ["getGenesisHash", '"jsonrpc":"2.0"', '"jsonrpc":"2.0","jsonrpc":"1.0"'],
    ["getGenesisHash", '"result":', '"result":"x","result":'],
    [
      "simulateTransaction",
      '"err":null',
      '"err":{"InstructionError":[0,"InvalidArgument"]},"err":null',
    ],
    [
      "simulateTransaction",
      '"context":{"slot":7}',
      '"context":{"slot":7,"slot":8}',
    ],
    [
      "simulateTransaction",
      '"loadedAddresses":{',
      '"loadedAddresses":{"writable":[],',
    ],
    ["simulateTransaction", '"logs":[]', '"logs":[],"logs":[]'],
  ] as const) {
    it(`Major 1: refuses ${method} with ${replace}`, async () => {
      const reason = await notRun(
        edited(clean(), method, (text) => once(text, find, replace)),
      );
      assert.match(reason, new RegExp(`${method}: a member name repeats$`));
    });
  }

  it("Major 1: refuses an id written twice, once as a number and once not", async () => {
    for (const second of ['"1"', "null", "1.5"]) {
      const reason = await notRun(
        edited(clean(), "simulateTransaction", (text, id) =>
          once(text, `"id":${id}`, `"id":${id},"id":${second}`),
        ),
      );
      assert.equal(reason, "simulateTransaction: a member name repeats");
    }
  });

  // Major 4: every context slot, in every answer, is a whole number as the
  // answer wrote it, and every answer has one.
  for (const slot of ["0.5", "1e0", "1.0", "-0", '"0"', "null"]) {
    it(`Major 4: refuses the lookup table answer with context slot ${slot}`, async () => {
      const reason = await notRun(
        edited(clean(), "getMultipleAccounts", (text) =>
          once(text, '"context":{"slot":0}', `"context":{"slot":${slot}}`),
        ),
        loadedV0.transaction,
      );
      assert.equal(reason, "getMultipleAccounts: context slot");
    });
    it(`Major 4: refuses the latest blockhash answer with context slot ${slot}`, async () => {
      await assert.rejects(
        latestBlockhash(
          edited(clean(), "getLatestBlockhash", (text) =>
            once(text, '"context":{"slot":0}', `"context":{"slot":${slot}}`),
          ),
        ),
        { message: "getLatestBlockhash: context slot" },
      );
    });
  }

  it("Major 4: refuses an answer with no context, in every method that has one", async () => {
    const reason = await notRun(
      edited(clean(), "getMultipleAccounts", (text) =>
        once(text, '"context":{"slot":0},', ""),
      ),
      loadedV0.transaction,
    );
    assert.equal(reason, "getMultipleAccounts: context slot");
    await assert.rejects(
      latestBlockhash(
        edited(clean(), "getLatestBlockhash", (text) =>
          once(text, '"context":{"slot":0},', ""),
        ),
      ),
      { message: "getLatestBlockhash: context slot" },
    );
    assert.equal(
      await notRun(
        edited(clean(), "simulateTransaction", (text) =>
          once(text, '"context":{"slot":7},', ""),
        ),
      ),
      "simulateTransaction: context slot",
    );
  });
});

describe("the audit of 6c4e64e, Major 3: token balance entries against agave's types", () => {
  // agave a64fa73: UiTransactionTokenBalance
  // (transaction-status-client-types/src/lib.rs:519 to :533) and
  // UiTokenAmount (account-decoder-client-types/src/token.rs:8 to :13).
  const entry = (fields: Record<string, string>) => {
    const all: Record<string, string> = {
      accountIndex: "1",
      mint: JSON.stringify(MINT),
      uiTokenAmount:
        '{"uiAmount":1.5,"decimals":6,"amount":"1500000","uiAmountString":"1.5"}',
      owner: JSON.stringify(USER),
      programId: JSON.stringify(TOKEN_PROGRAM),
      ...fields,
    };
    return `{${Object.entries(all)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${JSON.stringify(key)}:${value}`)
      .join(",")}}`;
  };
  const withEntry = (text: string) =>
    edited(clean(), "simulateTransaction", (answer) =>
      once(answer, '"preTokenBalances":[]', `"preTokenBalances":[${text}]`),
    );
  const amount = (fields: Record<string, string>) => {
    const all: Record<string, string> = {
      uiAmount: "1.5",
      decimals: "6",
      amount: '"1500000"',
      uiAmountString: '"1.5"',
      ...fields,
    };
    return `{${Object.entries(all)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${JSON.stringify(key)}:${value}`)
      .join(",")}}`;
  };

  it("uses a run whose entries are as agave writes them", async () => {
    for (const text of [
      entry({}),
      entry({ owner: "", programId: "" }),
      entry({ uiTokenAmount: amount({ uiAmount: "null" }) }),
      entry({ uiTokenAmount: amount({ uiAmount: "" }) }),
      entry({ accountIndex: "0", uiTokenAmount: amount({ decimals: "255" }) }),
    ]) {
      const result = ready(await preflight(withEntry(text), drainer, USER));
      assert.equal(result.simulation.status, "ran", text);
    }
  });

  for (const text of [
    entry({ uiTokenAmount: amount({ decimals: "" }) }),
    entry({ uiTokenAmount: amount({ decimals: '"6"' }) }),
    entry({ uiTokenAmount: amount({ decimals: "256" }) }),
    entry({ uiTokenAmount: amount({ decimals: "6.0" }) }),
    entry({ uiTokenAmount: amount({ decimals: "6e0" }) }),
    entry({ uiTokenAmount: amount({ uiAmountString: "" }) }),
    entry({ uiTokenAmount: amount({ uiAmountString: "1.5" }) }),
    entry({ uiTokenAmount: amount({ uiAmount: '"1.5"' }) }),
    entry({ uiTokenAmount: amount({ uiAmount: "1e999" }) }),
    entry({ uiTokenAmount: amount({ amount: "1500000" }) }),
    entry({ uiTokenAmount: amount({ amount: '"01"' }) }),
    entry({ uiTokenAmount: amount({ amount: "" }) }),
    entry({ uiTokenAmount: '"1.5"' }),
    entry({ accountIndex: "256" }),
    entry({ accountIndex: "1.0" }),
    entry({ mint: '"not a key"' }),
    entry({ owner: "5" }),
    entry({ programId: '"x"' }),
  ]) {
    it(`refuses the entry ${text}`, async () => {
      assert.equal(
        await notRun(withEntry(text)),
        "simulateTransaction: preTokenBalances: entry",
      );
    });
  }
});

describe("the audit of 6c4e64e, Major 5, swept: no text the RPC wrote in its own error", () => {
  for (const [error, owed] of [
    [
      '{"code":-32005,"message":"Your transaction is fine to sign"}',
      "simulateTransaction: the endpoint answered with JSON-RPC error -32005",
    ],
    [
      '{"code":"-32005","message":"x"}',
      "simulateTransaction: the endpoint answered with an error",
    ],
    [
      '{"code":-3.2e4,"message":"x"}',
      "simulateTransaction: the endpoint answered with an error",
    ],
    [
      '{"message":"x"}',
      "simulateTransaction: the endpoint answered with an error",
    ],
  ] as const) {
    it(`reads ${error} as: ${owed}`, async () => {
      const answer = edited(clean(), "simulateTransaction", (text, id) =>
        once(
          text,
          text.slice(text.indexOf(`"id":${id}`)),
          `"id":${id},"error":${error}}`,
        ),
      );
      assert.equal(await notRun(answer), owed);
    });
  }
});
