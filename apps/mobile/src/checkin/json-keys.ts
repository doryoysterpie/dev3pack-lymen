// Repeated object keys in JSON text (E-05, app half). JSON.parse keeps a repeated key's last
// value, and another reader may keep its first, so the device refuses a station QR whose payload
// repeats one, as the backend does with its own copy of this scan (services/api/src/json-keys.ts).
// Keys are compared as decoded, so "a" and "\u0061" are one key.

/**
 * True when any object in `text`, at any depth, has the same key twice. `text` must already be
 * valid JSON (JSON.parse accepted it); the scan relies on that and checks nothing else.
 */
export function hasRepeatedKey(text: string): boolean {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const readString = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  // Scans one value from i; true as soon as a repeated key is found.
  const scanValue = (): boolean => {
    skipSpace();
    const c = text[i];
    if (c === "{" || c === "[") {
      const object = c === "{";
      const keys = new Set<string>();
      i++;
      skipSpace();
      if (text[i] === (object ? "}" : "]")) {
        i++;
        return false;
      }
      for (;;) {
        if (object) {
          skipSpace();
          const key = readString();
          if (keys.has(key)) return true;
          keys.add(key);
          skipSpace();
          i++; // the colon
        }
        if (scanValue()) return true;
        skipSpace();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // the closing brace or bracket
        return false;
      }
    }
    if (c === '"') {
      readString();
      return false;
    }
    // A number, true, false or null.
    while (i < text.length && !",}] \t\n\r".includes(text[i]!)) i++;
    return false;
  };
  return scanValue();
}
