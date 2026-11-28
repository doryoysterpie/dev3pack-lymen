// The raw text of every number in a JSON text (E-09, the owner's ruling 20a).
// Pure module, plain string scanning, so it runs the same in Hermes and Node.
//
// JSON.parse keeps only the nearest double: 1.0000000000000001 reads as 1,
// and a u64 past 2^53 loses its low digits. The client checks each balance
// and slot it uses against the digits the answer sent, read here, so a value
// with a fraction or an exponent is refused before or after rounding alike.

/** The key a number's path is stored under: JSON.stringify of the path. */
export const pathKey = (path: readonly (string | number)[]): string =>
  JSON.stringify(path);

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

/**
 * Each number in text, as written, by the path of keys and indexes that leads
 * to it (pathKey). A repeated key keeps its last number, as JSON.parse keeps
 * its last value. Null when text is not JSON (RFC 8259).
 */
export function jsonNumbers(text: string): Map<string, string> | null {
  const numbers = new Map<string, string>();
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
    else if (isDigit(text[i]) && text[i] !== "0") {
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
  const value = (path: (string | number)[]): boolean => {
    space();
    const c = text[i];
    if (c === "{") {
      i += 1;
      space();
      if (text[i] === "}") {
        i += 1;
        return true;
      }
      for (;;) {
        space();
        const key = string();
        if (key === null) return false;
        space();
        if (text[i] !== ":") return false;
        i += 1;
        if (!value([...path, key])) return false;
        space();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return true;
        }
        return false;
      }
    }
    if (c === "[") {
      i += 1;
      space();
      if (text[i] === "]") {
        i += 1;
        return true;
      }
      for (let index = 0; ; index += 1) {
        if (!value([...path, index])) return false;
        space();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return true;
        }
        return false;
      }
    }
    if (c === '"') return string() !== null;
    if (c === "-" || isDigit(c)) {
      const raw = number();
      if (raw === null) return false;
      numbers.set(pathKey(path), raw);
      return true;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return true;
      }
    }
    return false;
  };
  if (!value([])) return null;
  space();
  return i === text.length ? numbers : null;
}
