// The one JSON reader for every JSON-RPC answer (E-09; the owner's audits of
// 21e1f9f, item 5, and of 6c4e64e, Majors 1 and 4). Pure module, plain
// string scanning, so it runs the same in Hermes and Node.
//
// JSON.parse keeps the last value of a repeated member name and only the
// nearest double of a number: 1.0000000000000001 reads as 1, and a u64 past
// 2^53 loses its low digits. This reader refuses a repeated member name at
// any depth, keeps every number as the text the answer wrote, and gives each
// object as a Map, so an answer cannot hold two values for one field, a
// whole number is checked digit for digit, and no member name reaches an
// object's prototype. The RPC client (rpc.ts) reads every answer through it
// and nothing else.

/** A JSON number, as the text the answer wrote it. */
export class JsonNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export type JsonValue =
  null | boolean | string | JsonNumber | readonly JsonValue[] | JsonObject;

/** A JSON object: its members by name, each name once. */
export type JsonObject = ReadonlyMap<string, JsonValue>;

export type JsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly problem: "not-json" | "repeated-member" };

const isDigit = (c: string | undefined): boolean =>
  c !== undefined && c >= "0" && c <= "9";

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Thrown inside parseJson only, for a member name an object already has. */
class RepeatedMember extends Error {}

/**
 * text as JSON (RFC 8259), or why it is not one limen reads: "not-json", or
 * "repeated-member" when an object at any depth names a member twice, the
 * names compared after their escapes are read ("a" and "a" are one
 * name).
 */
export function parseJson(text: string): JsonResult {
  let i = 0;
  const space = () => {
    while (
      text[i] === " " ||
      text[i] === "\t" ||
      text[i] === "\n" ||
      text[i] === "\r"
    ) {
      i += 1;
    }
  };
  const string = (): string | null => {
    if (text[i] !== '"') return null;
    i += 1;
    let out = "";
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const escaped = next === undefined ? undefined : ESCAPES[next];
        if (escaped === undefined) return null;
        out += escaped;
        i += 2;
        continue;
      }
      if (c < " ") return null;
      out += c;
      i += 1;
    }
    return null;
  };
  const number = (): string | null => {
    const start = i;
    if (text[i] === "-") i += 1;
    if (text[i] === "0") i += 1;
    else if (isDigit(text[i])) {
      while (isDigit(text[i])) i += 1;
    } else return null;
    if (text[i] === ".") {
      i += 1;
      if (!isDigit(text[i])) return null;
      while (isDigit(text[i])) i += 1;
    }
    if (text[i] === "e" || text[i] === "E") {
      i += 1;
      if (text[i] === "+" || text[i] === "-") i += 1;
      if (!isDigit(text[i])) return null;
      while (isDigit(text[i])) i += 1;
    }
    return text.slice(start, i);
  };
  // undefined: not JSON at this point.
  const value = (): JsonValue | undefined => {
    space();
    const c = text[i];
    if (c === "{") {
      i += 1;
      const members = new Map<string, JsonValue>();
      space();
      if (text[i] === "}") {
        i += 1;
        return members;
      }
      for (;;) {
        space();
        const name = string();
        if (name === null) return undefined;
        if (members.has(name)) throw new RepeatedMember();
        space();
        if (text[i] !== ":") return undefined;
        i += 1;
        const member = value();
        if (member === undefined) return undefined;
        members.set(name, member);
        space();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return members;
        }
        return undefined;
      }
    }
    if (c === "[") {
      i += 1;
      const items: JsonValue[] = [];
      space();
      if (text[i] === "]") {
        i += 1;
        return items;
      }
      for (;;) {
        const item = value();
        if (item === undefined) return undefined;
        items.push(item);
        space();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return items;
        }
        return undefined;
      }
    }
    if (c === '"') return string() ?? undefined;
    if (c === "-" || isDigit(c)) {
      const raw = number();
      return raw === null ? undefined : new JsonNumber(raw);
    }
    for (const [literal, meaning] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return meaning;
      }
    }
    return undefined;
  };
  try {
    const parsed = value();
    space();
    return parsed !== undefined && i === text.length
      ? { ok: true, value: parsed }
      : { ok: false, problem: "not-json" };
  } catch (error) {
    // A repeated name, or nesting deep enough to exhaust the stack.
    return {
      ok: false,
      problem: error instanceof RepeatedMember ? "repeated-member" : "not-json",
    };
  }
}

/** Whether a value is a JSON object. */
export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value instanceof Map;
}

/** Whether a value is a JSON array. */
export function isJsonArray(
  value: JsonValue | undefined,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * A whole number as the answer wrote it: digits only, with no sign, point,
 * exponent or leading zero, so 1.0, 1e0 and -0 are not one. Its text, or
 * null.
 */
export function wholeNumber(value: JsonValue | undefined): string | null {
  return value instanceof JsonNumber && /^(0|[1-9][0-9]*)$/.test(value.text)
    ? value.text
    : null;
}

/** A whole number from 0 to max, as written, or null. */
export function wholeUpTo(
  value: JsonValue | undefined,
  max: number,
): number | null {
  const text = wholeNumber(value);
  if (text === null || text.length > String(max).length) return null;
  const read = Number(text);
  return read <= max ? read : null;
}
