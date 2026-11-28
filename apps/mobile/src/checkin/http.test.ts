// E-05 app half (audit round 5, Major 2): appFetch binds directly to expo/fetch, never global
// fetch, so Expo's EXPO_PUBLIC_USE_RN_FETCH opt-in cannot swap in React Native's fetch (which
// drops redirect: "error"), and no shipping module under src/checkin calls global fetch.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import ts from "typescript";

import type { HttpFetch } from "./http.ts";

const nodeHttpFetch = globalThis.fetch;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "expo/fetch") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const fetch = (...args) => globalThis.__limenTestExpoFetch(...args);",
      };
    }
    return nextResolve(specifier, context);
  },
});

const stubSlot = globalThis as unknown as {
  __limenTestExpoFetch: HttpFetch;
};
stubSlot.__limenTestExpoFetch = (url, init) => nodeHttpFetch(url, init);

const { appFetch } = await import("./http.ts");
const { postCheckin } = await import("./client.ts");

test("appFetch defaults to expo/fetch, never global fetch, even with EXPO_PUBLIC_USE_RN_FETCH set", async () => {
  const expoCalls: { url: string; init: RequestInit | undefined }[] = [];
  const prevExpo = stubSlot.__limenTestExpoFetch;
  const realFetch = globalThis.fetch;
  const prevOptIn = process.env.EXPO_PUBLIC_USE_RN_FETCH;
  stubSlot.__limenTestExpoFetch = async (url, init) => {
    expoCalls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        status: "checked_in",
        station: "st-front",
        session: "day-2",
        mint: "Mint1111",
        signature: "Sig1111",
      }),
      { status: 201 },
    );
  };
  process.env.EXPO_PUBLIC_USE_RN_FETCH = "1";
  globalThis.fetch = (() => {
    throw new Error("global fetch must never be called");
  }) as unknown as typeof fetch;
  try {
    const res = await appFetch("https://api.example.test/checkins", {
      method: "POST",
      redirect: "follow",
      body: "{}",
    });
    assert.equal(res.status, 201);
    assert.equal(expoCalls.length, 1);
    assert.equal(expoCalls[0]!.url, "https://api.example.test/checkins");
    assert.equal(expoCalls[0]!.init?.redirect, "error");

    const checkedIn = await postCheckin(appFetch, "https://api.example.test", {
      qr: "limen:station:v1.payload.signer.signature",
      wallet: "6mmVXu9m4A3FQsggw4qxZzyjkA6GX5XKDK1cMUcmTF14",
      registrationId: "LMN-0001",
      signature: new Uint8Array(64),
    });
    assert.equal(checkedIn.ok, true);
    assert.equal(expoCalls.length, 2);
    assert.equal(expoCalls[1]!.url, "https://api.example.test/checkins");
    assert.equal(expoCalls[1]!.init?.redirect, "error");
  } finally {
    stubSlot.__limenTestExpoFetch = prevExpo;
    globalThis.fetch = realFetch;
    if (prevOptIn === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
    else process.env.EXPO_PUBLIC_USE_RN_FETCH = prevOptIn;
  }
});

test("http.ts imports fetch from expo/fetch and no shipping file under apps/mobile/src/checkin references global fetch", () => {
  const dir = new URL(".", import.meta.url);
  const files = readdirSync(dir)
    .filter(
      (name) =>
        (name.endsWith(".ts") || name.endsWith(".tsx")) &&
        !name.endsWith(".test.ts"),
    )
    .sort();
  assert.ok(files.includes("http.ts"));
  assert.ok(files.includes("client.ts"));
  assert.ok(files.includes("CheckinPanel.tsx"));

  const expoFetchImports: string[] = [];
  const offenders: string[] = [];

  for (const name of files) {
    const text = readFileSync(new URL(name, dir), "utf8");
    const sf = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "expo/fetch"
      ) {
        expoFetchImports.push(name);
      }
      if (ts.isIdentifier(node) && node.text === "fetch") {
        // Only the imported specifier `fetch` in `import { fetch as ... } from "expo/fetch"` in
        // http.ts is allowed; any other `fetch` identifier (call, default value, property access
        // such as globalThis.fetch, or type query) is flagged.
        const allowedImportSpecifier =
          name === "http.ts" &&
          ts.isImportSpecifier(node.parent) &&
          (node.parent.propertyName ?? node.parent.name) === node &&
          ts.isNamedImports(node.parent.parent) &&
          ts.isImportClause(node.parent.parent.parent) &&
          ts.isImportDeclaration(node.parent.parent.parent.parent) &&
          ts.isStringLiteral(
            node.parent.parent.parent.parent.moduleSpecifier,
          ) &&
          node.parent.parent.parent.parent.moduleSpecifier.text ===
            "expo/fetch";
        if (!allowedImportSpecifier) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          offenders.push(`${name}:${line + 1}`);
        }
      }
      if (
        ts.isElementAccessExpression(node) &&
        (ts.isStringLiteral(node.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
        node.argumentExpression.text === "fetch"
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push(`${name}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(expoFetchImports, ["http.ts"]);
  assert.deepEqual(offenders, []);
});
