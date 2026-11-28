// The owner's audit of 21e1f9f, item 6: the JSON-RPC envelope is checked as
// the answer wrote it.

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
      "getGenesisHash: the answer is for another request",
    );
    assert.equal(
      await reasonFor(
        (id) => `{"jsonrpc":"2.0","id":${id}e0,"result":${HASH}}`,
      ),
      "getGenesisHash: the answer is for another request",
    );
  });

  it("requires jsonrpc 2.0", async () => {
    for (const version of ['"1.0"', "2", "null"]) {
      assert.equal(
        await reasonFor(
          (id) => `{"jsonrpc":${version},"id":${id},"result":${HASH}}`,
        ),
        "getGenesisHash: not a JSON-RPC 2.0 answer",
      );
    }
    assert.equal(
      await reasonFor((id) => `{"id":${id},"result":${HASH}}`),
      "getGenesisHash: not a JSON-RPC 2.0 answer",
    );
  });

  it("refuses both a result and an error, and an error that is not an object", async () => {
    assert.equal(
      await reasonFor(
        (id) =>
          `{"jsonrpc":"2.0","id":${id},"result":${HASH},"error":{"code":1,"message":"x"}}`,
      ),
      "getGenesisHash: an answer with both a result and an error",
    );
    for (const error of ['"busy"', "7", "null", "[]"]) {
      assert.equal(
        await reasonFor(
          (id) => `{"jsonrpc":"2.0","id":${id},"error":${error}}`,
        ),
        "getGenesisHash: an error that is not an object",
      );
    }
  });
});
