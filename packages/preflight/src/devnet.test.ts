// The owner's audit of E-09 at 6c4e64e, Major 9: devnet is confirmed only by
// its exact genesis hash, and another cluster is named only for another
// well-formed hash.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as web3 from "@solana/web3.js";

import { edited, once } from "../test-support/build.ts";
import { preflight } from "./preflight.ts";
import { DEVNET_GENESIS_HASH } from "./programs.ts";
import {
  ATTACKER,
  USER,
  clean,
  drainer,
  notRun,
  offline,
} from "../test-support/audit.ts";

describe("the audit of 6c4e64e, Major 9: could not confirm devnet is not another cluster", () => {
  const genesis = (result: string) =>
    edited(clean(), "getGenesisHash", (text) =>
      once(text, JSON.stringify(DEVNET_GENESIS_HASH), result),
    );
  for (const result of [
    '""',
    '"abc"',
    "123",
    "null",
    '{"hash":1}',
    // 31 and 33 bytes in base58.
    JSON.stringify(web3.PublicKey.default.toBase58().slice(0, 31)),
    `"${DEVNET_GENESIS_HASH}1"`,
  ]) {
    it(`says it could not confirm devnet for a genesis result of ${result}`, async () => {
      assert.equal(
        await notRun(genesis(result)),
        "limen could not confirm devnet: getGenesisHash: not a 32-byte hash",
      );
    });
  }

  it("says it could not confirm devnet when the endpoint cannot be reached", async () => {
    assert.equal(
      await notRun(offline),
      "limen could not confirm devnet: getGenesisHash: the endpoint could not be reached",
    );
  });

  it("stops as another cluster only for another well-formed 32-byte hash", async () => {
    assert.deepEqual(
      await preflight(genesis(JSON.stringify(ATTACKER)), drainer, USER),
      { kind: "not-devnet" },
    );
  });
});
