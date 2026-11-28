// E-15 done test: every string on the app's result cards appears in the README's claims table.
//
// The test renders the card for every QR in the E-04 and E-08 fixtures, and for the inputs
// below that reach the card branches no fixture reaches. It checks both ways against the
// README's table "Strings on the app's result cards":
// - each title, status, row label and row value rendered matches a row of the table;
// - each row of the table matches a string rendered here, so the table holds no stale row.
// The strings on the screens around the card, in App.tsx and ui/LogoHeader.tsx, are checked
// the same way against the table "Strings around the card".
//
// A row may hold a placeholder in braces, from the list in PLACEHOLDERS; any other brace is a
// failure, so a row cannot match more than its placeholder allows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadRecipientLists } from "./pay/recipient-lists.ts";
import { resultCard } from "./result-card.ts";

const README = readFileSync(
  new URL("../../../README.md", import.meta.url),
  "utf8",
);

interface Fixture {
  readonly lists?: unknown;
  readonly cases: readonly { readonly text: string }[];
}
const fixture = (path: string): Fixture =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), "utf8"),
  ) as Fixture;

const transfers = fixture("pay/e08-transfer.json");
const LISTS = loadRecipientLists(transfers.lists);
const ORGANIZER = "3vMQ3uubVTa1BQf9cQE5FETCDhSP5ZbLjfv87zvvMe7p";

// Inputs for card branches the fixtures do not reach.
const EXTRA = [
  // A field that is not valid URL encoding.
  `solana:${ORGANIZER}?amount=1&label=%E0%A4%A`,
  // A message, quoted on one line.
  `solana:${ORGANIZER}?amount=1&message=Line%0Atwo`,
  // A transaction request over 2048 characters, and a solana: URL over it with no recipient
  // and no link, which is neither kind.
  `solana:https://example.com/${"a".repeat(2048)}`,
  `solana:?${"x".repeat(2049)}`,
];

/** Each placeholder a row may hold, and what it matches. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  "{address}": "[1-9A-HJ-NP-Za-km-z]{32,44}",
  "{addresses, one per line}":
    "[1-9A-HJ-NP-Za-km-z]{32,44}(?:\\n[1-9A-HJ-NP-Za-km-z]{32,44})*",
  "{amount}": "[0-9]+(?:\\.[0-9]+)?",
  "{link}": "https?://\\S+",
  "{text}": '(?:[^"\\\\]|\\\\.)*',
};

/** The first cell of each row under `heading`, without its backticks, up to the next heading. */
function tableRows(heading: string): string[] {
  const start = README.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `README.md has the heading ${heading}`);
  const rest = README.slice(start + heading.length + 2);
  const end = rest.search(/\n#{1,6} /);
  const rows: string[] = [];
  for (const line of (end === -1 ? rest : rest.slice(0, end)).split("\n")) {
    const cell = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (cell) rows.push(cell[1]!);
  }
  assert.ok(rows.length > 0, `the table under ${heading} has rows`);
  return rows;
}

/** A row as a regular expression over the whole string. */
function pattern(row: string): RegExp {
  let source = "";
  for (const part of row.split(/(\{[^}]*\})/)) {
    if (part.startsWith("{")) {
      const match = PLACEHOLDERS[part];
      assert.ok(match, `${JSON.stringify(row)}: ${part} is not a placeholder`);
      source += match;
    } else {
      source += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function assertTable(heading: string, shown: ReadonlySet<string>): void {
  const rows = tableRows(heading);
  const patterns = rows.map(pattern);
  for (const text of shown)
    assert.ok(
      patterns.some((p) => p.test(text)),
      `${JSON.stringify(text)} is shown but has no row under ${heading}`,
    );
  rows.forEach((row, i) =>
    assert.ok(
      [...shown].some((text) => patterns[i]!.test(text)),
      `the row ${JSON.stringify(row)} under ${heading} matches nothing shown`,
    ),
  );
}

test("E-15 done test: every string on the app's result cards has a row in the README, and every row is shown", () => {
  const inputs = [
    ...fixture("qr/e04-classify.json").cases.map((c) => c.text),
    ...transfers.cases.map((c) => c.text),
    ...EXTRA,
  ];
  const shown = new Set<string>();
  for (const text of inputs) {
    const card = resultCard(text, LISTS);
    shown.add(card.title);
    shown.add(card.status);
    for (const row of card.rows) {
      shown.add(row.label);
      shown.add(row.value);
    }
  }
  assertTable("### Strings on the app's result cards", shown);
});

test("E-15 done test: every string on the screens around the card has a row in the README", () => {
  const shown = new Set<string>();
  for (const file of ["../App.tsx", "./ui/LogoHeader.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    // Text between JSX tags, and the button titles and image alt text.
    for (const m of source.matchAll(/<Text[^>]*>\s*([^<{}]+?)\s*<\/Text>/g))
      shown.add(m[1]!.replace(/\s+/g, " "));
    for (const m of source.matchAll(/\b(?:title|alt)="([^"]+)"/g))
      shown.add(m[1]!);
  }
  assert.ok(shown.size > 0);
  assertTable("### Strings around the card", shown);
});
