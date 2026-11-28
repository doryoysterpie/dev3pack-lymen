import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodePublicKey } from "./base58.ts";
import {
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import type { AccountState } from "./rpc.ts";
import { balanceChanges } from "./simulate.ts";
import { parseLookupTable, parseTokenAccount } from "./state.ts";

const USER = "3vMQ3uubVTa1BQf9cQE5FETCDhSP5ZbLjfv87zvvMe7p";
const OTHER = "9tvU9qFD4Qiq3DFut32Bq1TgU3nEkrUqZdVy7ELe1uTD";
const MINT = "EzamibQgq4KbhJm44Wx8dFP13xmDrXZX5hBLhrVJnYDT";
const ACCOUNT = "GsJrhpq3YeSBYmKAtkbQFjYN9EoLJvVJvfvs9pTQ84Hc";

function token(owner: string, amount: number, length = 165): Uint8Array {
  const data = new Uint8Array(length);
  data.set(decodePublicKey(MINT) ?? new Uint8Array(32), 0);
  data.set(decodePublicKey(owner) ?? new Uint8Array(32), 32);
  data[64] = amount;
  data[108] = 1;
  return data;
}

/** A Token-2022 account with extensions: past 165 bytes, the Account type byte. */
function token2022(owner: string, amount: number): Uint8Array {
  const data = token(owner, amount, 200);
  data[165] = 2;
  return data;
}

const state = (
  owner: string,
  data: Uint8Array,
  lamports = "1",
): AccountState => ({
  lamports,
  owner,
  data,
});

describe("account data readers", () => {
  it("reads a token account and refuses short data or a bad delegate tag", () => {
    assert.deepEqual(parseTokenAccount(TOKEN_PROGRAM, token(USER, 7)), {
      mint: MINT,
      owner: USER,
      amount: "7",
      delegate: null,
      delegatedAmount: "0",
      closeAuthority: null,
    });
    assert.equal(parseTokenAccount(TOKEN_PROGRAM, token(USER, 7, 164)), null);
    const badTag = token(USER, 7);
    badTag[72] = 2;
    assert.equal(parseTokenAccount(TOKEN_PROGRAM, badTag), null);
  });

  it("reads a Token-2022 account with extensions by its account type byte", () => {
    const withExtensions = token(USER, 9, 200);
    withExtensions[165] = 2;
    assert.equal(
      parseTokenAccount(TOKEN_2022_PROGRAM, withExtensions)?.amount,
      "9",
    );
    assert.equal(
      parseTokenAccount(TOKEN_2022_PROGRAM, token(USER, 9))?.amount,
      "9",
    );
  });

  // re-audit 2, item 3: the layout each program unpacks (solana-program/token
  // 38de8d1, interface/src/state.rs:131 to 149 and :265 to 292;
  // solana-program/token-2022 efe55b4, interface/src/extension/mod.rs:275 to
  // 281, :316 to 337, :562 to 572 and :974 to 984).
  it("refuses every account the programs would not unpack as one", () => {
    const variant = (
      change: (data: Uint8Array) => void,
      length = 165,
    ): Uint8Array => {
      const data = token(USER, 9, length);
      change(data);
      return data;
    };
    const refused: ReadonlyArray<readonly [string, string, Uint8Array]> = [
      ["Token, 166 bytes", TOKEN_PROGRAM, token(USER, 9, 166)],
      [
        "Token, 200 bytes with a type byte",
        TOKEN_PROGRAM,
        variant((d) => (d[165] = 2), 200),
      ],
      ["Token-2022, 164 bytes", TOKEN_2022_PROGRAM, token(USER, 9, 164)],
      [
        "Token-2022, the Multisig length",
        TOKEN_2022_PROGRAM,
        variant((d) => (d[165] = 2), 355),
      ],
      [
        "Token-2022, a Mint type byte",
        TOKEN_2022_PROGRAM,
        variant((d) => (d[165] = 1), 200),
      ],
      [
        "Token-2022, no type byte",
        TOKEN_2022_PROGRAM,
        variant((d) => (d[165] = 0), 200),
      ],
      ["uninitialized", TOKEN_PROGRAM, variant((d) => (d[108] = 0))],
      ["an unknown state", TOKEN_PROGRAM, variant((d) => (d[108] = 3))],
      ["a delegate tag of 2", TOKEN_PROGRAM, variant((d) => (d[72] = 2))],
      [
        "a delegate tag with a high byte",
        TOKEN_2022_PROGRAM,
        variant((d) => (d[75] = 1)),
      ],
      ["an is_native tag of 2", TOKEN_PROGRAM, variant((d) => (d[109] = 2))],
      [
        "a close authority tag of 2",
        TOKEN_PROGRAM,
        variant((d) => (d[129] = 2)),
      ],
      ["not a token program's", SYSTEM_PROGRAM, token(USER, 9)],
    ];
    for (const [name, program, data] of refused) {
      assert.equal(parseTokenAccount(program, data), null, name);
    }
    // Frozen and wrapped SOL are still token accounts.
    assert.ok(
      parseTokenAccount(
        TOKEN_PROGRAM,
        variant((d) => (d[108] = 2)),
      ),
    );
    assert.ok(
      parseTokenAccount(
        TOKEN_PROGRAM,
        variant((d) => (d[109] = 1)),
      ),
    );
  });

  it("refuses lookup table data with the wrong tag or a partial address", () => {
    const table = new Uint8Array(56 + 32);
    assert.equal(parseLookupTable(table), null); // tag 0: uninitialized
    table[0] = 1;
    assert.equal(parseLookupTable(table)?.length, 1);
    assert.equal(parseLookupTable(table.slice(0, 56 + 31)), null);
  });
});

describe("balance changes", () => {
  // Each transaction here lists its token program, as agave requires before
  // it reports token balances (svm/src/transaction_balances.rs:83 and :96).
  it("reports a closed token account as emptied, with no owner after", () => {
    const changes = balanceChanges(
      USER,
      [USER, ACCOUNT],
      [
        state(SYSTEM_PROGRAM, new Uint8Array(), "100"),
        state(TOKEN_PROGRAM, token(USER, 5)),
      ],
      [state(SYSTEM_PROGRAM, new Uint8Array(), "100"), null],
      {
        keys: [USER, ACCOUNT, TOKEN_PROGRAM],
        pre: ["100", "1", "1"],
        post: ["100", "0", "1"],
        preToken: [{ accountIndex: 1, mint: MINT, owner: USER, amount: "5" }],
        postToken: [],
      },
    );
    assert.deepEqual(changes, [
      {
        kind: "token",
        account: ACCOUNT,
        mint: MINT,
        before: "5",
        after: "0",
        delegateBefore: null,
        delegateAfter: null,
        delegatedAmountBefore: "0",
        delegatedAmountAfter: "0",
        ownerAfter: null,
        closeAuthorityBefore: null,
        closeAuthorityAfter: null,
      },
    ]);
  });

  it("reports an owner change on a Token-2022 account", () => {
    const changes = balanceChanges(
      USER,
      [USER, ACCOUNT],
      [null, state(TOKEN_2022_PROGRAM, token2022(USER, 5))],
      [null, state(TOKEN_2022_PROGRAM, token2022(OTHER, 5))],
      {
        keys: [USER, ACCOUNT, TOKEN_2022_PROGRAM],
        pre: ["0", "1", "1"],
        post: ["0", "1", "1"],
        preToken: [{ accountIndex: 1, mint: MINT, owner: USER, amount: "5" }],
        postToken: [{ accountIndex: 1, mint: MINT, owner: OTHER, amount: "5" }],
      },
    );
    assert.equal(changes.length, 1);
    assert.ok(changes[0].kind === "token");
    assert.equal(changes[0].ownerAfter, OTHER);
  });

  it("ignores token accounts the user does not own, and accounts that did not change", () => {
    const changes = balanceChanges(
      USER,
      [USER, ACCOUNT],
      [
        state(SYSTEM_PROGRAM, new Uint8Array(), "100"),
        state(TOKEN_PROGRAM, token(OTHER, 5)),
      ],
      [
        state(SYSTEM_PROGRAM, new Uint8Array(), "100"),
        state(TOKEN_PROGRAM, token(OTHER, 0)),
      ],
      {
        keys: [USER, ACCOUNT, TOKEN_PROGRAM],
        pre: ["100", "1", "1"],
        post: ["100", "1", "1"],
        preToken: [{ accountIndex: 1, mint: MINT, owner: OTHER, amount: "5" }],
        postToken: [{ accountIndex: 1, mint: MINT, owner: OTHER, amount: "0" }],
      },
    );
    assert.deepEqual(changes, []);
  });
});
