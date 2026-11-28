// The owner's audit of E-09 at 77f925f, item 1: the package's only RPC is
// its own JSON-RPC client. No caller can pass an RPC adapter of its own, and
// the client calls no method on anything a fetch gives it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { recordedEndpoint } from "../test-support/recorded.ts";
import * as pkg from "./index.ts";
import { preflight } from "./preflight.ts";
import { DEVNET_GENESIS_HASH, SYSTEM_PROGRAM } from "./programs.ts";
import type { Fetch, RpcEndpoint } from "./rpc.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly cases: readonly {
    readonly name: string;
    readonly transaction: string;
  }[];
};
const USER = fixture.user;
const drainer = fixture.cases[0].transaction;

describe("re-audit 2, item 1: no RPC surface but the package's own client", () => {
  it("exports no RPC adapter, client or recorded data", () => {
    for (const name of [
      "jsonRpc",
      "recordedRpc",
      "recordedEndpoint",
      "assertDevnet",
      "RpcError",
    ]) {
      assert.equal(name in pkg, false, name);
    }
    for (const name of ["preflight", "latestBlockhash", "readAnswer"]) {
      assert.equal(typeof (pkg as Record<string, unknown>)[name], "function");
    }
  });

  it("refuses an object shaped like an RPC adapter, and calls none of its methods", async () => {
    const called: string[] = [];
    const adapter = {
      getGenesisHash: async () => (
        called.push("getGenesisHash"),
        DEVNET_GENESIS_HASH
      ),
      getAccounts: async () => (called.push("getAccounts"), []),
      simulate: async () => (called.push("simulate"), {}),
      latestBlockhash: async () => (called.push("latestBlockhash"), ""),
    };
    const result = await preflight(adapter as never, drainer, USER);
    assert.ok(result.kind === "ready");
    assert.deepEqual(result.simulation, {
      status: "not-run",
      reason: "not an RPC endpoint",
    });
    assert.deepEqual(called, []);
  });

  it("reads only the text of a fetch's answer, and calls no method on it", async () => {
    const recorded = recordedEndpoint({
      accounts: {
        [USER]: {
          lamports: 5_000_000_000,
          owner: SYSTEM_PROGRAM,
          data: ["", "base64"],
        },
      },
      simulation: { err: null, accounts: {} },
    });
    let methodsCalled = 0;
    const withMethods: Fetch = async (url, init) => {
      const answer = await recorded.fetch(url, init);
      return {
        ...answer,
        json: async () => {
          methodsCalled += 1;
          return JSON.parse(answer.text) as unknown;
        },
      } as never;
    };
    const used = await preflight(
      { url: recorded.url, fetch: withMethods } satisfies RpcEndpoint,
      drainer,
      USER,
    );
    assert.ok(used.kind === "ready");
    assert.equal(used.simulation.status, "ran");
    assert.equal(methodsCalled, 0);

    // An answer that offers its body only through a method is refused.
    const methodOnly: Fetch = async (url, init) => {
      const answer = await recorded.fetch(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => {
          methodsCalled += 1;
          return JSON.parse(answer.text) as unknown;
        },
      } as never;
    };
    const refused = await preflight(
      { url: "x", fetch: methodOnly },
      drainer,
      USER,
    );
    assert.ok(refused.kind === "ready");
    assert.deepEqual(refused.simulation, {
      status: "not-run",
      reason: "the answer's body is not text",
    });
    assert.equal(methodsCalled, 0);
  });
});

describe("ruling 20a, item 8: a fetch's rejection is never read", () => {
  it("reports a fixed reason, and reads nothing of what the fetch threw", async () => {
    const touched: string[] = [];
    const thrown = new Proxy(
      {},
      {
        get: (_target, key) => {
          touched.push(`get ${String(key)}`);
          return () => "spoofed";
        },
        getPrototypeOf: () => {
          touched.push("getPrototypeOf");
          return Error.prototype;
        },
        getOwnPropertyDescriptor: (_target, key) => {
          touched.push(`descriptor ${String(key)}`);
          return undefined;
        },
      },
    );
    const result = await preflight(
      {
        url: "https://rpc.example/",
        fetch: () => Promise.reject(thrown),
      },
      drainer,
      USER,
    );
    assert.ok(result.kind === "ready");
    assert.deepEqual(result.simulation, {
      status: "not-run",
      reason: "getGenesisHash: the endpoint could not be reached",
    });
    assert.deepEqual(touched, []);
  });

  it("still names a time limit it set itself", async () => {
    const result = await preflight(
      {
        url: "https://rpc.example/",
        fetch: () => new Promise(() => {}),
        timeoutMs: 20,
      },
      drainer,
      USER,
    );
    assert.ok(result.kind === "ready");
    assert.deepEqual(result.simulation, {
      status: "not-run",
      reason: "the RPC endpoint did not answer within 0.02 seconds",
    });
  });
});
