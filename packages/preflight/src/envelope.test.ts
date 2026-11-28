// The owner's audit of 21e1f9f, item 6: the JSON-RPC envelope is checked as
// the answer wrote it. Each answer here is the genesis hash's, the first one
// asked, so a refusal leaves devnet unconfirmed (the audit of 6c4e64e, Major
// 9).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { preflight } from "./preflight.ts";
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

// Answers getGenesisHash with the text envelope(id) writes.
const answering = (envelope: (id: number) => string): RpcEndpoint => ({
  url: "https://rpc.example/",
  fetch: async (url, init) => {
    const { id } = JSON.parse(init.body) as { id: number };
    return { ok: true, status: 200, url, text: envelope(id) };
  },
});
const reasonFor = async (envelope: (id: number) => string) => {
  const result = await preflight(
    answering(envelope),
    fixture.cases[0].transaction,
    fixture.user,
  );
  assert.ok(result.kind === "ready");
  assert.equal(result.simulation.status, "not-run");
  return result.simulation.status === "not-run" ? result.simulation.reason : "";
};
const HASH = JSON.stringify(DEVNET_GENESIS_HASH);

describe("the audit of 21e1f9f, item 6: the JSON-RPC envelope", () => {
  it("compares the id as written, so 1.0000000000000001 is not 1", async () => {
    assert.equal(
      await reasonFor(
        (id) =>
          `{"jsonrpc":"2.0","id":${id}.0000000000000001,"result":${HASH}}`,
      ),
      "limen could not confirm devnet: getGenesisHash: the answer is for another request",
    );
    assert.equal(
      await reasonFor(
        (id) => `{"jsonrpc":"2.0","id":${id}e0,"result":${HASH}}`,
      ),
      "limen could not confirm devnet: getGenesisHash: the answer is for another request",
    );
  });

  it("says limen could not tell which request the answer is for when id is absent or not a number", async () => {
    for (const envelope of [
      () => `{"jsonrpc":"2.0","result":${HASH}}`,
      () => `{"jsonrpc":"2.0","id":null,"result":${HASH}}`,
      () => `{"jsonrpc":"2.0","id":"","result":${HASH}}`,
      (id: number) => `{"jsonrpc":"2.0","id":"${id}","result":${HASH}}`,
    ]) {
      assert.equal(
        await reasonFor(envelope),
        "limen could not confirm devnet: getGenesisHash: the answer gave no request id limen can read, so limen could not tell which request it is for",
      );
    }
  });

  it("requires jsonrpc 2.0", async () => {
    for (const version of ['"1.0"', "2", "null"]) {
      assert.equal(
        await reasonFor(
          (id) => `{"jsonrpc":${version},"id":${id},"result":${HASH}}`,
        ),
        "limen could not confirm devnet: getGenesisHash: not a JSON-RPC 2.0 answer",
      );
    }
    assert.equal(
      await reasonFor((id) => `{"id":${id},"result":${HASH}}`),
      "limen could not confirm devnet: getGenesisHash: not a JSON-RPC 2.0 answer",
    );
  });

  it("refuses both a result and an error, and an error that is not an object", async () => {
    assert.equal(
      await reasonFor(
        (id) =>
          `{"jsonrpc":"2.0","id":${id},"result":${HASH},"error":{"code":1,"message":"x"}}`,
      ),
      "limen could not confirm devnet: getGenesisHash: an answer with both a result and an error",
    );
    for (const error of ['"busy"', "7", "null", "[]"]) {
      assert.equal(
        await reasonFor(
          (id) => `{"jsonrpc":"2.0","id":${id},"error":${error}}`,
        ),
        "limen could not confirm devnet: getGenesisHash: an error that is not an object",
      );
    }
  });
});
