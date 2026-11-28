// The owner's audit of E-09 at 6c4e64e, Major 2: addresses from lookup
// tables reach the decode, the card and the bundle only on the path where
// every check passed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edited, once } from "../test-support/build.ts";
import { preflight, type Preflight } from "./preflight.ts";
import {
  ATTACKER,
  BLOCKHASH,
  MINT,
  OTHER,
  USER,
  clean,
  loadedV0,
  ready,
} from "../test-support/audit.ts";

describe("the audit of 6c4e64e, Major 2: lookup addresses only on the path where every check passed", () => {
  const attackerFound = (result: Extract<Preflight, { kind: "ready" }>) =>
    JSON.stringify({
      summary: result.summary,
      recipients: result.recipients,
      accountKeys: result.accountKeys,
    }).includes(ATTACKER);

  it("names the attacker from the table when the run is used", async () => {
    const result = ready(await preflight(clean(), loadedV0.transaction, USER));
    assert.equal(result.simulation.status, "ran");
    assert.equal(attackerFound(result), true);
    assert.ok(result.recipients.includes(ATTACKER));
  });

  // Each refusal the clean-run path makes, with the run's loaded addresses
  // also disputing the table read.
  const disputed = (text: string) => once(text, ATTACKER, OTHER);
  for (const [name, edit] of [
    ["alone", (text: string) => text],
    [
      "a balance list one entry short",
      (text: string) =>
        once(text, '"preBalances":[5000000000,', '"preBalances":['),
    ],
    [
      "a balance list one entry long",
      (text: string) => once(text, '"preBalances":[', '"preBalances":[0,'),
    ],
    [
      "a token entry outside the message",
      (text: string) =>
        once(
          text,
          '"preTokenBalances":[]',
          `"preTokenBalances":[{"accountIndex":99,"mint":${JSON.stringify(MINT)},"uiTokenAmount":{"uiAmount":1,"decimals":0,"amount":"1","uiAmountString":"1"}}]`,
        ),
    ],
    [
      "a malformed token entry",
      (text: string) =>
        once(
          text,
          '"preTokenBalances":[]',
          '"preTokenBalances":[{"accountIndex":0}]',
        ),
    ],
    [
      "a slot with a fraction",
      (text: string) =>
        once(text, '"context":{"slot":7}', '"context":{"slot":7.5}'),
    ],
    ["no err field", (text: string) => once(text, '"err":null,', "")],
    [
      "a repeated member",
      (text: string) => once(text, '"logs":[]', '"logs":[],"logs":[]'),
    ],
    [
      "a malformed replacement blockhash",
      (text: string) =>
        once(text, `"blockhash":"${BLOCKHASH}"`, '"blockhash":"x"'),
    ],
    ["an answer that is not JSON", (text: string) => `${text}x`],
  ] as const) {
    it(`leaves every lookup entry unresolved: table disputed, and ${name}`, async () => {
      const result = ready(
        await preflight(
          edited(clean(), "simulateTransaction", (text) =>
            edit(disputed(text)),
          ),
          loadedV0.transaction,
          USER,
        ),
      );
      assert.equal(result.simulation.status, "not-run");
      assert.equal(attackerFound(result), false);
      assert.equal(result.summary.unresolvedAccounts > 0, true);
    });
  }

  it("leaves every lookup entry unresolved when the run cannot be reached", async () => {
    const base = clean();
    const result = ready(
      await preflight(
        {
          url: base.url,
          fetch: async (url, init) => {
            if (init.body.includes("simulateTransaction")) {
              throw new Error("down");
            }
            return base.fetch(url, init);
          },
        },
        loadedV0.transaction,
        USER,
      ),
    );
    assert.equal(result.simulation.status, "not-run");
    assert.equal(attackerFound(result), false);
  });
});
