// Test support, not part of the package's exports (E-09): transactions built
// with @solana/web3.js 1.99.0 and @solana/spl-token 0.4.15, and an endpoint
// whose answers are edited as text, for the cases from the owner's audit of
// 6c4e64e.

import assert from "node:assert/strict";

import * as web3 from "@solana/web3.js";

import type { RpcEndpoint } from "../src/rpc.ts";

/**
 * A legacy transaction with no signatures, its fee payer first, as base64.
 * The blockhash is any 32-byte value; the simulation replaces it.
 */
export function legacy(
  payer: string,
  instructions: readonly web3.TransactionInstruction[],
  blockhash: string,
): string {
  const message = new web3.TransactionMessage({
    payerKey: new web3.PublicKey(payer),
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToLegacyMessage();
  return Buffer.from(
    new web3.VersionedTransaction(message).serialize(),
  ).toString("base64");
}

/**
 * The endpoint with the answer text to one method rewritten by edit, which
 * is given the request's id. An edit that changes nothing fails the test, so
 * no case passes by leaving the answer as it was.
 */
export function edited(
  base: RpcEndpoint,
  method: string,
  edit: (text: string, id: number) => string,
): RpcEndpoint {
  return {
    url: base.url,
    fetch: async (url, init) => {
      const answer = await base.fetch(url, init);
      const request = JSON.parse(init.body) as { id: number; method: string };
      if (request.method !== method) return answer;
      const text = edit(answer.text, request.id);
      assert.notEqual(text, answer.text, `the edit changed nothing: ${method}`);
      return { ...answer, text };
    },
  };
}

/**
 * Multisig signers as @solana/spl-token takes them. Since the services pin
 * @solana/web3.js 1.98.4 (services/api/package.json), spl-token resolves that
 * copy, not this package's 1.99.0, and its addSigners takes a signer that is
 * not its own PublicKey class by the signer's publicKey (@solana/spl-token
 * 0.4.15, src/instructions/internal.ts). So each key is given as a Signer;
 * the secret key is never read.
 */
export function asSigners(
  keys: readonly web3.PublicKey[],
): { publicKey: web3.PublicKey; secretKey: Uint8Array }[] {
  return keys.map((publicKey) => ({
    publicKey,
    secretKey: new Uint8Array(64),
  }));
}

/** Replaces the one occurrence of find in text; there must be exactly one. */
export function once(text: string, find: string, replace: string): string {
  const at = text.indexOf(find);
  assert.ok(at >= 0, `not found: ${find}`);
  assert.equal(text.indexOf(find, at + 1), -1, `found twice: ${find}`);
  return `${text.slice(0, at)}${replace}${text.slice(at + find.length)}`;
}
