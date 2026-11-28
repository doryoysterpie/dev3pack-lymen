// The owner's audit of E-09 at 6c4e64e, Major 5: a failed run's error is
// shown only as agave's TransactionError and InstructionError variant names,
// with an instruction index and a Custom code only where the answer's text
// writes them as agave does.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edited, once } from "../test-support/build.ts";
import { preflight, toReport } from "./preflight.ts";
import {
  ATTACKER,
  MINT,
  USER,
  clean,
  drainer,
  ready,
} from "../test-support/audit.ts";

describe("the audit of 6c4e64e, Major 5: a failed run's error only as agave names it", () => {
  const failing = (err: string) =>
    edited(clean(), "simulateTransaction", (text) =>
      once(text, '"err":null', `"err":${err}`),
    );
  const none = {
    transactionError: null,
    instruction: null,
    instructionError: null,
    custom: null,
  };
  for (const [err, owed] of [
    [
      '"InsufficientFundsForFee"',
      { ...none, transactionError: "InsufficientFundsForFee" },
    ],
    [
      '{"InstructionError":[2,{"Custom":4294967295}]}',
      {
        transactionError: "InstructionError",
        instruction: 2,
        instructionError: "Custom",
        custom: 4294967295,
      },
    ],
    [
      '{"InstructionError":[2,"InvalidAccountData"]}',
      {
        ...none,
        transactionError: "InstructionError",
        instruction: 2,
        instructionError: "InvalidAccountData",
      },
    ],
    // A code past the largest u32, or past JavaScript's exact integers, or
    // written with a fraction or exponent, is not shown.
    ...["4294967296", "9007199254740993", "1.0", "1e0", "-1", '"1"'].map(
      (code) =>
        [
          `{"InstructionError":[2,{"Custom":${code}}]}`,
          {
            ...none,
            transactionError: "InstructionError",
            instruction: 2,
            instructionError: "Custom",
          },
        ] as const,
    ),
    // Custom always carries its code (instruction-error 13ec001,
    // src/lib.rs:139); a name agave does not have is not shown.
    [
      '{"InstructionError":[2,"Custom"]}',
      { ...none, transactionError: "InstructionError", instruction: 2 },
    ],
    [
      '{"InstructionError":[2,"YourWalletIsFine"]}',
      { ...none, transactionError: "InstructionError", instruction: 2 },
    ],
    [
      '{"DuplicateInstruction":1}',
      { ...none, transactionError: "DuplicateInstruction" },
    ],
    [
      '{"InsufficientFundsForRent":{"account_index":3}}',
      { ...none, transactionError: "InsufficientFundsForRent" },
    ],
    // Anything else: detail not shown.
    ['{"InstructionError":[256,"InvalidArgument"]}', none],
    ['{"InstructionError":[2.0,"InvalidArgument"]}', none],
    ['{"InstructionError":[2,"InvalidArgument"],"x":1}', none],
    ['{"InsufficientFundsForRent":{"account_index":3.5}}', none],
    ['{"DuplicateInstruction":"1"}', none],
    ['"YourWalletIsFine"', none],
    ['{"YourWalletIsFine":1}', none],
    [`{"${ATTACKER}":1,"${MINT}":2}`, none],
    ["1e999", none],
    ["[]", none],
    ["true", none],
  ] as const) {
    it(`reports ${err} as ${JSON.stringify(owed)}`, async () => {
      const result = ready(await preflight(failing(err), drainer, USER));
      assert.ok(result.simulation.status === "ran");
      assert.deepEqual(result.simulation.err, owed);
      assert.deepEqual(result.blocks, ["simulation-failed"]);
      const report = toReport(result);
      assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
      assert.ok(report.kind === "ready" && report.simulation.status === "ran");
      assert.deepEqual(report.simulation.err, owed);
    });
  }
});
