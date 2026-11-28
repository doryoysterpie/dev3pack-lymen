// The owner's audit of 21e1f9f, item 8: a System Assign that names the
// wallet itself as the new owner hands nothing to another address.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as web3 from "@solana/web3.js";

import { endpointFor } from "../test-support/recorded.ts";
import { drainPattern } from "./drain.ts";
import { preflight, toReport } from "./preflight.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as { readonly user: string; readonly keys: Readonly<Record<string, string>> };
const user = new web3.PublicKey(fixture.user);

const assigning = (programId: web3.PublicKey) => {
  const message = new web3.TransactionMessage({
    payerKey: user,
    recentBlockhash: fixture.keys.mint,
    instructions: [
      web3.SystemProgram.assign({ accountPubkey: user, programId }),
    ],
  }).compileToLegacyMessage();
  return Buffer.from(
    new web3.VersionedTransaction(message).serialize(),
  ).toString("base64");
};
const offline = endpointFor(async () => {
  throw new Error("offline");
}, "x");

describe("the audit of 21e1f9f, item 8: a self-assign is no hand-over", () => {
  it("shows no drain pattern for the wallet as its own new owner", async () => {
    const result = await preflight(offline, assigning(user), fixture.user);
    assert.ok(result.kind === "ready");
    assert.deepEqual(
      result.summary.effects.map((effect) =>
        effect.kind === "owner-assigned" ? effect.newOwner : effect.kind,
      ),
      ["user"],
    );
    assert.equal(drainPattern(toReport(result)), false);
  });

  it("still shows one for another program", async () => {
    const other = new web3.PublicKey(fixture.keys.unknownProgram);
    const result = await preflight(offline, assigning(other), fixture.user);
    assert.ok(result.kind === "ready");
    assert.equal(drainPattern(toReport(result)), true);
  });
});
