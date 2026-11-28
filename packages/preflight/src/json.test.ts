import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JsonNumber,
  parseJson,
  wholeNumber,
  wholeUpTo,
  type JsonValue,
} from "./json.ts";

const parsed = (text: string): JsonValue => {
  const result = parseJson(text);
  assert.ok(result.ok, text);
  return result.value;
};

describe("parseJson: the one reader for every answer", () => {
  it("keeps each number as written, in objects and lists, past strings", () => {
    const value = parsed(
      '{"a":[1.0000000000000001, -0, 2e5],"b\\"]":{"c":18446744073709551615},"d":"9,\\u0022e\\":1","a2":[]}',
    );
    assert.deepEqual(
      value,
      new Map<string, JsonValue>([
        [
          "a",
          [
            new JsonNumber("1.0000000000000001"),
            new JsonNumber("-0"),
            new JsonNumber("2e5"),
          ],
        ],
        ['b"]', new Map([["c", new JsonNumber("18446744073709551615")]])],
        ["d", '9,"e":1'],
        ["a2", []],
      ]),
    );
  });

  it("the audit of 6c4e64e, Major 1: refuses a member name repeated at any depth", () => {
    for (const text of [
      '{"a":1,"a":2.5}',
      '{"a":1,"a":"1"}',
      '{"a":1,"\\u0061":1}',
      '{"x":[{"b":null,"b":null}]}',
      '{"x":{"y":{"z":{"w":1,"w":1}}}}',
    ]) {
      assert.deepEqual(
        parseJson(text),
        { ok: false, problem: "repeated-member" },
        text,
      );
    }
    // The same name in two objects is not a repeat.
    assert.ok(parseJson('{"a":{"b":1},"c":{"b":2}}').ok);
  });

  it("gives objects as Maps, so no member name reaches a prototype", () => {
    const value = parsed('{"__proto__":{"polluted":true}}');
    assert.ok(value instanceof Map);
    assert.deepEqual([...value.keys()], ["__proto__"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
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
      '"a\u0001"',
      "[".repeat(100000),
    ]) {
      assert.deepEqual(parseJson(bad), { ok: false, problem: "not-json" }, bad);
    }
  });

  it("agrees with JSON.parse on which texts are JSON", () => {
    for (const text of [
      '{"a":[true,false,null,"x"]}',
      " [ ] ",
      "0",
      '"\\u00e9"',
    ]) {
      assert.ok(parseJson(text).ok, text);
      JSON.parse(text);
    }
  });

  it("reads a whole number only as digits with no sign, point or exponent", () => {
    for (const [text, owed] of [
      ["0", "0"],
      ["7", "7"],
      ["18446744073709551615", "18446744073709551615"],
      ["-0", null],
      ["1.0", null],
      ["1e0", null],
      ["1.0000000000000001", null],
      ['"1"', null],
      ["null", null],
    ] as const) {
      assert.equal(wholeNumber(parsed(text)), owed, text);
    }
    assert.equal(wholeUpTo(parsed("255"), 255), 255);
    assert.equal(wholeUpTo(parsed("256"), 255), null);
    assert.equal(
      wholeUpTo(parsed("9007199254740993"), Number.MAX_SAFE_INTEGER),
      null,
    );
    assert.equal(
      wholeUpTo(parsed("9007199254740991"), Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
  });
});
