import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Fetch } from "@limen/preflight";

import { requestTransaction, RequestError } from "./request.ts";

const LINK = "https://pay.example/solana-pay?order=7";
const ACCOUNT = "3vMQ3uubVTa1BQf9cQE5FETCDhSP5ZbLjfv87zvvMe7p";

// A link that answers with the given body, as text.
const answering =
  (body: () => Promise<unknown>): Fetch =>
  async (url) => ({
    ok: true,
    status: 200,
    url,
    text: JSON.stringify(await body()),
  });

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
      await reasonOf(async (url) => ({
        ok: true,
        status: 200,
        url,
        text: "Unexpected <html>",
      })),
      "not-json: the link did not answer with JSON",
    );
  });
});

describe("re-audit 2, item 7: a redirected request is refused", () => {
  const REDIRECTED =
    "redirected: the request was redirected to another address, so limen will not show what it answered";
  // A link that answers a transaction from the given final URL.
  const from =
    (url: string): Fetch =>
    async () => ({
      ok: true,
      status: 200,
      url,
      text: JSON.stringify({ transaction: "AQ==" }),
    });

  it("refuses an answer from another host", async () => {
    assert.equal(
      await reasonOf(from("https://elsewhere.example/solana-pay?order=7")),
      REDIRECTED,
    );
  });

  it("refuses an answer from another path or query on the same host", async () => {
    assert.equal(
      await reasonOf(from("https://pay.example/other?order=7")),
      REDIRECTED,
    );
    assert.equal(
      await reasonOf(from("https://pay.example/solana-pay?order=8")),
      REDIRECTED,
    );
  });

  it("refuses an answer that gives no final URL, or one written differently", async () => {
    assert.equal(await reasonOf(from("")), REDIRECTED);
    assert.equal(
      await reasonOf(from("https://PAY.example/solana-pay?order=7")),
      REDIRECTED,
    );
  });

  it("reads an answer from the link itself, whose fragment is never sent", async () => {
    assert.equal(await reasonOf(from(LINK)), "answered");
    const answer = await requestTransaction(
      from(LINK),
      `${LINK}#top`,
      ACCOUNT,
      50,
    );
    assert.deepEqual(answer, { transaction: "AQ==", message: null });
  });
});
