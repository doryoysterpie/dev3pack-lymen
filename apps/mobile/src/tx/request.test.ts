import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Fetch } from "@limen/preflight";

import { requestTransaction, RequestError } from "./request.ts";

const LINK = "https://pay.example/solana-pay?order=7";
const ACCOUNT = "3vMQ3uubVTa1BQf9cQE5FETCDhSP5ZbLjfv87zvvMe7p";

const answering =
  (body: () => Promise<unknown>): Fetch =>
  async () => ({ ok: true, status: 200, json: body });

async function reasonOf(fetch: Fetch): Promise<string> {
  try {
    await requestTransaction(fetch, LINK, ACCOUNT, 50);
  } catch (error) {
    assert.ok(error instanceof RequestError);
    return `${error.reason}: ${error.message}`;
  }
  return "answered";
}

describe("m10: the transaction request link has a time limit", () => {
  it("times out a link that never answers", async () => {
    assert.equal(
      await reasonOf(() => new Promise(() => {})),
      "timeout: the link did not answer within 0.05 seconds",
    );
  });

  it("times out a link whose body never arrives", async () => {
    assert.equal(
      await reasonOf(answering(() => new Promise(() => {}))),
      "timeout: the link did not answer within 0.05 seconds",
    );
  });

  it("reads a link that answers in time", async () => {
    const answer = await requestTransaction(
      answering(async () => ({ transaction: "AQ==", message: "Thanks" })),
      LINK,
      ACCOUNT,
      50,
    );
    assert.deepEqual(answer, { transaction: "AQ==", message: "Thanks" });
  });

  it("still says when the body is not JSON", async () => {
    assert.equal(
      await reasonOf(
        answering(async () => {
          throw new SyntaxError("Unexpected token");
        }),
      ),
      "not-json: the link did not answer with JSON",
    );
  });
});
