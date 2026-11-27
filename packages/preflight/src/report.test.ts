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
import { recordedRpc, type RecordedAccount } from "./recorded.ts";
import { jsonRpc, type Fetch } from "./rpc.ts";
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
        rpc: recordedRpc({
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

  it("numbers the wallet's token accounts in the message's account order", async () => {
    const c = fixture.cases.find((entry) =>
      entry.name.startsWith("Token-2022"),
    );
    assert.ok(c !== undefined);
    const result = await preflightTransaction(decodeBase64(c.transaction)!, {
      rpc: recordedRpc({
        accounts: {
          [fixture.user]: sol(5_000_000_000),
          [K.userTokenAccount]: token(TOKEN_PROGRAM, fixture.user, 9),
          [K.userToken2022Account]: token(TOKEN_2022_PROGRAM, fixture.user, 9),
        },
        simulation: { err: null, accounts: {} },
      }),
      user: fixture.user,
    });
    assert.ok(result.summary.kind === "ready");
    const effects = result.summary.summary.effects;
    // The checked transfer and the owner change are on the Token-2022
    // account, the close on the Token account, which comes later in the
    // message.
    assert.ok(effects[0].kind === "token-out");
    assert.deepEqual(effects[0].source, { address: "user token account 1" });
    assert.ok(effects[2].kind === "account-closed");
    assert.deepEqual(effects[2].account, { address: "user token account 2" });
  });

  it("with no simulation, marks a token account the wallet approves from as its owner", async () => {
    const c = fixture.cases.find((entry) => entry.name.startsWith("drainer:"));
    assert.ok(c !== undefined);
    const offline: Fetch = async () => {
      throw new Error("offline");
    };
    const result = await preflightTransaction(decodeBase64(c.transaction)!, {
      rpc: jsonRpc(offline, "x"),
      user: fixture.user,
    });
    assert.ok(result.summary.kind === "ready");
    assert.equal(result.summary.simulation.status, "not-run");
    const approve = result.summary.summary.effects.find(
      (effect) => effect.kind === "delegate-approved",
    );
    assert.ok(approve !== undefined && approve.kind === "delegate-approved");
    assert.deepEqual(approve.account, { address: "user token account 1" });
    assert.equal(JSON.stringify(result).includes(K.userTokenAccount), false);
  });

  it("scrubs addresses from the RPC's error text and from the runtime error", async () => {
    const c = fixture.cases.find((entry) => entry.name.startsWith("drainer:"));
    assert.ok(c !== undefined);
    const answering =
      (answer: (method: string) => unknown): Fetch =>
      async (_url, init) => {
        const request = JSON.parse(init.body) as { id: number; method: string };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: request.id,
            ...(answer(request.method) as object),
          }),
        };
      };
    // The PM's second read: an endpoint that passes the devnet check and
    // names the wallet in an error.
    const limited = await preflightTransaction(decodeBase64(c.transaction)!, {
      rpc: jsonRpc(
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
      reason: "getMultipleAccounts: account an address is rate limited",
    });

    const failed = await preflightTransaction(decodeBase64(c.transaction)!, {
      rpc: recordedRpc({
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
    assert.deepEqual(failed.summary.simulation.err, {
      Custom: "insufficient funds in an address",
    });
    assert.equal(JSON.stringify(failed).includes(fixture.user), false);
  });
});
