// The MWA signer, driven by a fake wallet that signs as the MWA fake wallet does: the signed
// message is the message followed by the 64-byte signature.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

import { ed25519Verify } from "./ed25519.ts";
import {
  mwaSigner,
  signatureFromSignedPayload,
  type MwaWallet,
  type Transact,
} from "./mwa-signer.ts";
import { encodeBase58 } from "./wallet-address.ts";

function fakeWallet(
  opts: {
    tamper?: "signature" | "message";
    accounts?: number;
    base58?: boolean;
  } = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  );
  const calls: { method: string; params: unknown }[] = [];
  const address = opts.base58 ? encodeBase58(key) : key.toString("base64");
  const wallet: MwaWallet = {
    async authorize(params) {
      calls.push({ method: "authorize", params });
      return {
        accounts: Array.from({ length: opts.accounts ?? 1 }, () => ({
          address,
        })),
      };
    },
    async signMessages(params) {
      calls.push({ method: "signMessages", params });
      const message = Buffer.from(params.payloads[0] ?? "", "base64");
      let signature = sign(null, message, privateKey);
      if (opts.tamper === "signature")
        signature = Buffer.from(signature.map((b, i) => (i === 0 ? b ^ 1 : b)));
      const body =
        opts.tamper === "message"
          ? Buffer.concat([message, Buffer.from("x")]).subarray(1)
          : message;
      return {
        signed_payloads: [Buffer.concat([body, signature]).toString("base64")],
      };
    },
  };
  const transact: Transact = (callback) => callback(wallet);
  return { key, calls, transact };
}

const MESSAGE = new Uint8Array(
  Buffer.from("limen check-in v1\nstation: st-front", "ascii"),
);

test("the signer authorizes on devnet, signs the message built for the account, and returns its signature", async () => {
  const w = fakeWallet();
  const signer = mwaSigner(w.transact, {
    appName: "limen",
    chain: "solana:devnet",
    verify: ed25519Verify,
  });
  const built: string[] = [];
  const result = await signer.signCheckin((wallet) => {
    built.push(wallet);
    return MESSAGE;
  });
  assert.equal(result.wallet, encodeBase58(w.key));
  assert.deepEqual(
    built,
    [encodeBase58(w.key)],
    "the message is built for the account's base58 address",
  );
  assert.equal(ed25519Verify(w.key, MESSAGE, result.signature), true);
  assert.deepEqual(w.calls[0], {
    method: "authorize",
    params: { identity: { name: "limen" }, chain: "solana:devnet" },
  });
  assert.deepEqual(w.calls[1], {
    method: "signMessages",
    params: {
      addresses: [w.key.toString("base64")],
      payloads: [Buffer.from(MESSAGE).toString("base64")],
    },
  });
});

test("a wallet-standard account given in base58 works the same", async () => {
  const w = fakeWallet({ base58: true });
  const signer = mwaSigner(w.transact, {
    appName: "limen",
    chain: "solana:devnet",
    verify: ed25519Verify,
  });
  const result = await signer.signCheckin(() => MESSAGE);
  assert.equal(result.wallet, encodeBase58(w.key));
});

test("a bad signature, a changed message or no account is refused before anything is sent", async () => {
  for (const [opts, message] of [
    [
      { tamper: "signature" },
      "The wallet's signature does not verify for its own key.",
    ],
    [
      { tamper: "message" },
      "The wallet's signature does not verify for its own key.",
    ],
    [{ accounts: 0 }, "The wallet authorized no account."],
  ] as const) {
    const w = fakeWallet(opts);
    const signer = mwaSigner(w.transact, {
      appName: "limen",
      chain: "solana:devnet",
      verify: ed25519Verify,
    });
    await assert.rejects(
      signer.signCheckin(() => MESSAGE),
      { message },
    );
  }
});

test("only a signed message that is exactly the message plus 64 bytes yields a signature", () => {
  const sig = new Uint8Array(64).fill(7);
  assert.deepEqual(
    signatureFromSignedPayload(new Uint8Array([...MESSAGE, ...sig]), MESSAGE),
    sig,
  );
  assert.equal(
    signatureFromSignedPayload(new Uint8Array([...sig, ...MESSAGE]), MESSAGE),
    null,
  );
  assert.equal(signatureFromSignedPayload(sig, MESSAGE), null);
});
