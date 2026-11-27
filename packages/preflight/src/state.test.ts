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
    assert.deepEqual(parseTokenAccount(token(USER, 7)), {
      mint: MINT,
      owner: USER,
      amount: "7",
      delegate: null,
      delegatedAmount: "0",
      closeAuthority: null,
    });
    assert.equal(parseTokenAccount(token(USER, 7, 164)), null);
    const badTag = token(USER, 7);
    badTag[72] = 2;
    assert.equal(parseTokenAccount(badTag), null);
  });

  it("reads a Token-2022 account by its first 165 bytes", () => {
    assert.equal(parseTokenAccount(token(USER, 9, 200))?.amount, "9");
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
  it("reports a closed token account as emptied, with no owner after", () => {
    const changes = balanceChanges(
      USER,
      [USER, ACCOUNT],
      [
        state(SYSTEM_PROGRAM, new Uint8Array(), "100"),
        state(TOKEN_PROGRAM, token(USER, 5)),
      ],
      [state(SYSTEM_PROGRAM, new Uint8Array(), "100"), null],
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
      [null, state(TOKEN_2022_PROGRAM, token(USER, 5, 200))],
      [null, state(TOKEN_2022_PROGRAM, token(OTHER, 5, 200))],
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
    );
    assert.deepEqual(changes, []);
  });
});
