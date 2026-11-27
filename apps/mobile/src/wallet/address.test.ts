import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodePublicKey } from "../qr/base58.ts";
import { walletAddress } from "./address.ts";

const KEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BYTES = decodePublicKey(KEY) ?? new Uint8Array();

describe("wallet address", () => {
  it("reads the base64 address the wallet adapter returns", () => {
    // Owed base64 from Node's Buffer, an independent encoder.
    const base64 = Buffer.from(BYTES).toString("base64");
    assert.equal(walletAddress({ address: base64 }), KEY);
  });

  it("prefers a wallet-standard account's public key bytes", () => {
    assert.equal(walletAddress({ address: KEY, publicKey: BYTES }), KEY);
  });

  it("refuses an address that is not 32 bytes", () => {
    assert.equal(walletAddress({ address: "QUJD" }), null);
    assert.equal(walletAddress({ address: "not base64" }), null);
  });
});
