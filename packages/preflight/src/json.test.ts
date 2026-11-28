import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jsonNumbers, pathKey } from "./json.ts";

describe("jsonNumbers: each number's text, by its path", () => {
  it("reads numbers as written, in objects and lists, past strings", () => {
    const numbers = jsonNumbers(
      '{"a":[1.0000000000000001, -0, 2e5],"b\\"]":{"c":18446744073709551615},"d":"9,\\u0022e\\":1","a2":[]}',
    );
    assert.ok(numbers !== null);
    assert.deepEqual(Object.fromEntries(numbers), {
      [pathKey(["a", 0])]: "1.0000000000000001",
      [pathKey(["a", 1])]: "-0",
      [pathKey(["a", 2])]: "2e5",
      [pathKey(['b"]', "c"])]: "18446744073709551615",
    });
  });

  it("keeps the last number of a repeated key, as JSON.parse does", () => {
    assert.equal(jsonNumbers('{"a":1,"a":2.5}')?.get(pathKey(["a"])), "2.5");
  });

  it("refuses text that is not JSON", () => {
    for (const bad of [
      "",
      "01",
      "1.",
      "-",
      "[1,]",
      '{"a"}',
      '"\\x"',
      "1 2",
      "nul",
    ]) {
      assert.equal(jsonNumbers(bad), null, bad);
    }
  });

  it("agrees with JSON.parse on which texts are JSON", () => {
    for (const text of [
      '{"a":[true,false,null,"x"]}',
      " [ ] ",
      "0",
      '"\\u00e9"',
    ]) {
      assert.notEqual(jsonNumbers(text), null, text);
      JSON.parse(text);
    }
  });
});
