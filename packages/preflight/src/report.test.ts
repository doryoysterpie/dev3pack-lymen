import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodePublicKey } from "./base58.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { preflightTransaction } from "./preflight.ts";
import {
  DEVNET_GENESIS_HASH,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import {
  endpointFor,
  recordedEndpoint,
  type RecordedAccount,
} from "../test-support/recorded.ts";
import type { Fetch } from "./rpc.ts";
import { parseTransaction } from "./wire.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
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

const K = fixture.keys;

const sol = (lamports: number): RecordedAccount => ({
  lamports,
  owner: SYSTEM_PROGRAM,
  data: ["", "base64"],
});

/** A 165-byte token account of the fixture mint, owned by owner. */
function token(
  program: string,
  owner: string,
  amount: number,
): RecordedAccount {
  const data = new Uint8Array(165);
  data.set(decodePublicKey(K.mint) ?? new Uint8Array(32), 0);
  data.set(decodePublicKey(owner) ?? new Uint8Array(32), 32);
  data[64] = amount;
  data[108] = 1;
  return {
    lamports: 2_039_280,
    owner: program,
    data: [encodeBase64(data), "base64"],
  };
}

const walletOf = (base64: string): string => {
  const bytes = decodeBase64(base64);
  assert.ok(bytes !== null);
  const parsed = parseTransaction(bytes);
  assert.ok(parsed.ok);
  return parsed.transaction.message.staticKeys[0];
};

describe("n3: a report names neither the wallet nor its token accounts", () => {
  for (const c of fixture.cases) {
    it(c.name, async () => {
      const wallet = walletOf(c.transaction);
      // The wallet's balance and both of its token accounts change, so their
      // addresses would appear in the report if anything wrote them.
      const result = await preflightTransaction(decodeBase64(c.transaction)!, {
        endpoint: recordedEndpoint({
          accounts: {
            [wallet]: sol(5_000_000_000),
            [K.userTokenAccount]: token(TOKEN_PROGRAM, wallet, 9),
            [K.userToken2022Account]: token(TOKEN_2022_PROGRAM, wallet, 9),
          },
          simulation: {
            err: null,
            accounts: {
              [wallet]: sol(4_000_000_000),
              [K.userTokenAccount]: token(TOKEN_PROGRAM, wallet, 3),
              [K.userToken2022Account]: token(TOKEN_2022_PROGRAM, wallet, 3),
            },
          },
        }),
        user: wallet,
      });
      assert.equal(result.summary.kind, "ready");
      assert.ok(result.summary.kind === "ready");
      assert.equal(result.summary.summary.signers.feePayer, "user");
      const json = JSON.stringify(result);
      for (const address of [
        wallet,
        K.userTokenAccount,
        K.userToken2022Account,
      ]) {
        assert.equal(json.includes(address), false, address);
      }
    });
  }

  it("shows no text from the RPC's error, nor from the runtime error", async () => {
    const c = fixture.cases.find((entry) => entry.name.startsWith("drainer:"));
    assert.ok(c !== undefined);
    const answering =
      (answer: (method: string) => unknown): Fetch =>
      async (url, init) => {
        const request = JSON.parse(init.body) as { id: number; method: string };
        return {
          ok: true,
          status: 200,
          url,
          text: JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            ...(answer(request.method) as object),
          }),
        };
      };
    // The PM's second read: an endpoint that passes the devnet check and
    // names the wallet in an error.
    const limited = await preflightTransaction(decodeBase64(c.transaction)!, {
      endpoint: endpointFor(
        answering((method) =>
          method === "getGenesisHash"
            ? { result: DEVNET_GENESIS_HASH }
            : {
                error: {
                  code: -32005,
                  message: `account ${fixture.user} is rate limited`,
                },
              },
        ),
        "x",
      ),
      user: fixture.user,
    });
    assert.ok(limited.summary.kind === "ready");
    assert.deepEqual(limited.summary.simulation, {
      status: "not-run",
      // limen reads no account (ruling 20a), so the first call after the
      // devnet check is the simulation. Only the error's code is shown (the
      // audit of 6c4e64e, Major 5, swept to the RPC's own errors).
      reason:
        "simulateTransaction: the endpoint answered with JSON-RPC error -32005",
    });

    const failed = await preflightTransaction(decodeBase64(c.transaction)!, {
      endpoint: recordedEndpoint({
        accounts: { [fixture.user]: sol(5_000_000_000) },
        simulation: {
          err: { Custom: `insufficient funds in ${fixture.user}` },
          accounts: {},
        },
      }),
      user: fixture.user,
    });
    assert.ok(failed.summary.kind === "ready");
    assert.ok(failed.summary.simulation.status === "ran");
    // Not agave's form, so no detail is shown (failure.ts; the audit of
    // 6c4e64e, Major 5): the runtime error carries only agave's names.
    assert.deepEqual(failed.summary.simulation.err, {
      transactionError: null,
      instruction: null,
      instructionError: null,
      custom: null,
    });
    assert.equal(JSON.stringify(failed).includes(fixture.user), false);
  });
});

describe("ruling 20a, item 3: a report names no address but six known programs", () => {
  // System, SPL Token, Token-2022, associated token, Compute Budget, Memo.
  const allowed = new Set([
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  ]);
  /** Every run of base58 text in the JSON that is a public key. */
  const addressesIn = (json: string): string[] =>
    (json.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? []).filter(
      (run) => decodePublicKey(run) !== null,
    );
  const offline = endpointFor(async () => {
    throw new Error("offline");
  }, "x");
  const withRun = recordedEndpoint({
    accounts: {
      [fixture.user]: sol(5_000_000_000),
    },
    simulation: { err: null, accounts: {} },
  });

  for (const c of fixture.cases) {
    it(`${c.name}: only allowed program IDs, offline and with a run`, async () => {
      const bytes = decodeBase64(c.transaction);
      assert.ok(bytes !== null);
      const parsed = parseTransaction(bytes);
      const user = parsed.ok ? parsed.transaction.message.staticKeys[0] : "";
      for (const endpoint of [offline, withRun]) {
        const result = await preflightTransaction(bytes, { endpoint, user });
        const found = addressesIn(JSON.stringify(result));
        assert.deepEqual(
          found.filter((address) => !allowed.has(address)),
          [],
          c.name,
        );
      }
    });
  }
});
