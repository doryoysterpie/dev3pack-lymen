import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseLookupTable } from "./state.ts";

describe("account data readers", () => {
  it("refuses lookup table data with the wrong tag or a partial address", () => {
    const table = new Uint8Array(56 + 32);
    assert.equal(parseLookupTable(table), null); // tag 0: uninitialized
    table[0] = 1;
    assert.equal(parseLookupTable(table)?.length, 1);
    assert.equal(parseLookupTable(table.slice(0, 56 + 31)), null);
  });
});
