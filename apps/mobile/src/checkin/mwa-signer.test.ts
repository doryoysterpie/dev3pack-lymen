// The MWA signer, driven by a fake wallet that signs as the MWA fake wallet does: the signed
// message is the message followed by the 64-byte signature. connect and sign each run in their own
// session, as the app shows the message between them.
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
    /** The account the wallet authorizes when asked again with its token: by default, the same. */
    laterAccount?: "same" | "none" | "other";
  } = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  );
  const calls: { method: string; params: unknown }[] = [];
  let sessions = 0;
  const address = opts.base58 ? encodeBase58(key) : key.toString("base64");
  const other = Buffer.alloc(32, 9).toString("base64");
  const wallet: MwaWallet = {
    async authorize(params) {
      calls.push({ method: "authorize", params });
      if (params.auth_token !== undefined && params.auth_token !== "token-1")
        throw new Error("unknown auth token");
      const later = params.auth_token !== undefined;
      const which = later ? (opts.laterAccount ?? "same") : "same";
      const count = which === "none" ? 0 : (opts.accounts ?? 1);
      return {
        accounts: Array.from({ length: count }, () => ({
          address: which === "other" ? other : address,
        })),
        auth_token: "token-1",
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
  const transact: Transact = (callback) => {
    sessions += 1;
    return callback(wallet);
  };
  return { key, address, calls, transact, sessions: () => sessions };
}

const MESSAGE = new Uint8Array(
  Buffer.from("limen check-in v1\nstation: st-front", "ascii"),
);

const signerFor = (w: ReturnType<typeof fakeWallet>) =>
  mwaSigner(w.transact, {
    appName: "limen",
    chain: "solana:devnet",
    verify: ed25519Verify,
  });

test("connect authorizes on devnet in one session and signs nothing", async () => {
  const w = fakeWallet();
  const account = await signerFor(w).connect();
  assert.deepEqual(account, {
    wallet: encodeBase58(w.key),
    key: new Uint8Array(w.key),
    address: w.key.toString("base64"),
    authToken: "token-1",
  });
  assert.deepEqual(w.calls, [
    {
      method: "authorize",
      params: { identity: { name: "limen" }, chain: "solana:devnet" },
    },
  ]);
  assert.equal(w.sessions(), 1);
});

test("sign authorizes again with the account's token in a second session and signs exactly the message", async () => {
  const w = fakeWallet();
  const signer = signerFor(w);
  const account = await signer.connect();
  const signature = await signer.sign(account, MESSAGE);
  assert.equal(ed25519Verify(w.key, MESSAGE, signature), true);
  assert.deepEqual(w.calls.slice(1), [
    {
      method: "authorize",
      params: {
        identity: { name: "limen" },
        chain: "solana:devnet",
        auth_token: "token-1",
      },
    },
    {
      method: "signMessages",
      params: {
        addresses: [w.key.toString("base64")],
        payloads: [Buffer.from(MESSAGE).toString("base64")],
      },
    },
  ]);
  assert.equal(w.sessions(), 2);
});

test("a wallet-standard account given in base58 works the same", async () => {
  const w = fakeWallet({ base58: true });
  const signer = signerFor(w);
  const account = await signer.connect();
  assert.equal(account.wallet, encodeBase58(w.key));
  assert.equal(
    ed25519Verify(w.key, MESSAGE, await signer.sign(account, MESSAGE)),
    true,
  );
});

test("a bad signature, a changed message, no account, or an account no longer authorized is refused before anything is sent", async () => {
  for (const [opts, message] of [
    [
      { tamper: "signature" },
      "The wallet's signature does not verify for its own key.",
    ],
    [
      { tamper: "message" },
      "The wallet's signature does not verify for its own key.",
    ],
    [
      { laterAccount: "none" },
      "The wallet no longer authorizes the account the message names.",
    ],
    [
      { laterAccount: "other" },
      "The wallet no longer authorizes the account the message names.",
    ],
  ] as const) {
    const w = fakeWallet(opts);
    const signer = signerFor(w);
    const account = await signer.connect();
    await assert.rejects(signer.sign(account, MESSAGE), { message });
  }
  await assert.rejects(signerFor(fakeWallet({ accounts: 0 })).connect(), {
    message: "The wallet authorized no account.",
  });
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
