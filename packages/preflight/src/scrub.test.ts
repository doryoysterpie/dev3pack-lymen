// The owner's audit of 21e1f9f, item 2: text the RPC wrote keeps no base58
// run of 32 or more characters, wherever it sits, unless it is one of the
// six program IDs a report may carry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodeBase64 } from "./base64.ts";
import { preflightTransaction } from "./preflight.ts";
import { DEVNET_GENESIS_HASH, SYSTEM_PROGRAM } from "./programs.ts";
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
const drainer = decodeBase64(fixture.cases[0].transaction)!;
// An address no account list or table of the drainer names.
const OFF = "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN";
const RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/g;

const answering = (simulate: unknown): RpcEndpoint => ({
  url: "https://rpc.example/",
  fetch: async (url, init) => {
    const { id, method } = JSON.parse(init.body) as {
      id: number;
      method: string;
    };
    const body =
      method === "getGenesisHash"
        ? { result: DEVNET_GENESIS_HASH }
        : (simulate as object);
    return {
      ok: true,
      status: 200,
      url,
      text: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
    };
  },
});

const runs = (value: unknown) => JSON.stringify(value).match(RUN) ?? [];

describe("the audit of 21e1f9f, item 2: RPC text keeps no address", () => {
  it("shows no text of a run's error, so no address in it, keys included, reaches the report", async () => {
    const result = await preflightTransaction(drainer, {
      endpoint: answering({
        result: {
          context: { slot: 1 },
          value: {
            err: {
              [`key${OFF}`]: `abc${OFF}def`,
              note: `Program ${SYSTEM_PROGRAM} failed for ${OFF}`,
            },
          },
        },
      }),
      user: fixture.user,
    });
    assert.ok(result.summary.kind === "ready");
    assert.ok(result.summary.simulation.status === "ran");
    // Not agave's form, so no detail is shown (failure.ts; the audit of
    // 6c4e64e, Major 5).
    assert.deepEqual(result.summary.simulation.err, {
      transactionError: null,
      instruction: null,
      instructionError: null,
      custom: null,
    });
    assert.deepEqual(runs(result), []);
  });

  it("scrubs one inside an RPC error message", async () => {
    const result = await preflightTransaction(drainer, {
      endpoint: answering({
        error: { code: -32005, message: `limited for abc${OFF}def` },
      }),
      user: fixture.user,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
    assert.deepEqual(runs(result), []);
  });
});
