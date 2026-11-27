import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodeBase64 } from "./base64.ts";
import { preflightTransaction } from "./preflight.ts";
import { SYSTEM_PROGRAM } from "./programs.ts";
import { recordedRpc, type RecordedAccount } from "./recorded.ts";
import { parseTransaction } from "./wire.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly cases: readonly {
    readonly name: string;
    readonly transaction: string;
  }[];
};

const sol = (lamports: number): RecordedAccount => ({
  lamports,
  owner: SYSTEM_PROGRAM,
  data: ["", "base64"],
});

describe("a report carries no wallet address", () => {
  for (const c of fixture.cases) {
    it(c.name, async () => {
      const bytes = decodeBase64(c.transaction);
      assert.ok(bytes !== null);
      const parsed = parseTransaction(bytes);
      assert.ok(parsed.ok);
      const wallet = parsed.transaction.message.staticKeys[0];
      // The simulation changes the wallet's balance, so its address would
      // appear in the changes if anything wrote it.
      const result = await preflightTransaction(bytes, {
        rpc: recordedRpc({
          accounts: { [wallet]: sol(5_000_000_000) },
          simulation: { err: null, accounts: { [wallet]: sol(4_000_000_000) } },
        }),
        user: wallet,
      });
      assert.equal(result.summary.kind, "ready");
      assert.ok(result.summary.kind === "ready");
      assert.equal(result.summary.summary.signers.feePayer, "user");
      assert.equal(JSON.stringify(result).includes(wallet), false);
    });
  }
});
