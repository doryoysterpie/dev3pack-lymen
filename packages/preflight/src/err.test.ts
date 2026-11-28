// The owner's audit of 21e1f9f, item 7: a run's error is JSON-safe data, so
// a failed run never serializes its error as null.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodeBase64 } from "./base64.ts";
import { preflightTransaction } from "./preflight.ts";
import { DEVNET_GENESIS_HASH } from "./programs.ts";
import type { RpcEndpoint } from "./rpc.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly cases: readonly { readonly transaction: string }[];
};

// A run that fails with the error text given, written by hand.
const failing = (err: string): RpcEndpoint => ({
  url: "https://rpc.example/",
  fetch: async (url, init) => {
    const { id, method } = JSON.parse(init.body) as {
      id: number;
      method: string;
    };
    const result =
      method === "getGenesisHash"
        ? JSON.stringify(DEVNET_GENESIS_HASH)
        : `{"context":{"slot":1},"value":{"err":${err}}}`;
    return {
      ok: true,
      status: 200,
      url,
      text: `{"jsonrpc":"2.0","id":${id},"result":${result}}`,
    };
  },
});

describe("the audit of 21e1f9f, item 7: a run's error is JSON-safe", () => {
  for (const [err, owed] of [
    [
      '{"InstructionError":[0,{"Custom":1e999}]}',
      { InstructionError: [0, { Custom: "1e999" }] },
    ],
    ["-1e999", "-1e999"],
    ["[1e400, 2]", ["1e400", 2]],
    ['{"__proto__":{"x":1e999}}', JSON.parse('{"__proto__":{"x":"1e999"}}')],
  ] as const) {
    it(`keeps ${err} as data that survives JSON`, async () => {
      const result = await preflightTransaction(
        decodeBase64(fixture.cases[0].transaction)!,
        { endpoint: failing(err), user: fixture.user },
      );
      assert.ok(result.summary.kind === "ready");
      assert.ok(result.summary.simulation.status === "ran");
      assert.deepEqual(result.summary.simulation.err, owed);
      const again = JSON.parse(JSON.stringify(result)) as typeof result;
      assert.ok(again.summary.kind === "ready");
      assert.deepEqual(again.summary.simulation, result.summary.simulation);
      assert.deepEqual(again.summary.blocks, ["simulation-failed"]);
    });
  }
});
