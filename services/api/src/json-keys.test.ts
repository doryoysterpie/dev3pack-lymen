// hasRepeatedKey finds a key an object repeats at any depth, comparing keys as decoded, and nothing
// else: not a key text inside a string value, not the same key in two different objects.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hasRepeatedKey } from "./json-keys.ts";

test("a key repeated in one object, at any depth or in an escaped spelling, is found", () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":{"b":1,"b":2}}',
    '{"a":[{"k":1,"k":1}]}',
    ' { "x" : null , "x" : true } ',
  ]) {
    assert.equal(JSON.parse(text) !== undefined, true, "valid JSON");
    assert.equal(hasRepeatedKey(text), true, text);
  }
});

test("one key in two objects, or a key's text inside a string, is not a repeat", () => {
  for (const text of [
    "{}",
    '"str"',
    "[1,2,3]",
    '[{"x":1},{"x":2}]',
    '{"a":"\\"a\\":1","b":[1,{"a":2}]}',
    ' { "a" : [ ] , "b" : { } , "c" : -1.5e3 } ',
  ]) {
    assert.equal(hasRepeatedKey(text), false, text);
  }
});
