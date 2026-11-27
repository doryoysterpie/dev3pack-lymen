import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { messageAccounts } from "./accounts.ts";
import { decodeBase64 } from "./base64.ts";
import { parseTransaction } from "./wire.ts";

interface OrderCase {
  readonly transaction: string;
  readonly tables: Readonly<Record<string, readonly string[]>>;
  readonly owed: readonly {
    readonly address: string;
    readonly signer: boolean;
    readonly writable: boolean;
  }[];
}

const { accountOrder } = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as { readonly accountOrder: OrderCase };

function message() {
  const bytes = decodeBase64(accountOrder.transaction);
  assert.ok(bytes !== null);
  const result = parseTransaction(bytes);
  assert.ok(result.ok);
  return result.transaction.message;
}

describe("account order across two lookup tables", () => {
  it("matches the order and flags web3.js gives", () => {
    const accounts = messageAccounts(
      message(),
      new Map(Object.entries(accountOrder.tables)),
    );
    assert.deepEqual(
      accounts.map(({ address, signer, writable }) => ({
        address,
        signer,
        writable,
      })),
      accountOrder.owed,
    );
  });

  it("leaves lookup addresses null, with their place, when no table is loaded", () => {
    const accounts = messageAccounts(message(), new Map());
    const loaded = accounts.filter((account) => account.lookup !== null);
    assert.equal(loaded.length, 4);
    assert.ok(loaded.every((account) => account.address === null));
  });
});
