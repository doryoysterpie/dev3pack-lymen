// E-19: the built station page draws the limen logo inline in its heading, using the path from
// assets/limen-logo.svg with fill="currentColor", and references no external asset file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));
const LOGO_ASSET = fileURLToPath(
  new URL("../../../assets/limen-logo.svg", import.meta.url),
);

/** Builds the station page into a fresh folder using the package's build script. */
function buildStation(): string {
  const outDir = mkdtempSync(join(tmpdir(), "limen-station-logo-"));
  const result = spawnSync(
    process.execPath,
    [join(APP, "build.ts"), "--outDir", outDir],
    {
      cwd: APP,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 0, `build: ${result.stderr.slice(-600)}`);
  return outDir;
}

/** Reads an attribute's double-quoted value from an HTML/SVG opening tag's attribute string. */
function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i").exec(attrs);
  return match?.[1] ?? null;
}

test("the built station page has one inline limen logo SVG in the heading and references no external asset", () => {
  const asset = readFileSync(LOGO_ASSET, "utf8");
  const assetSvg = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i.exec(asset);
  assert.ok(assetSvg !== null, "assets/limen-logo.svg has an <svg> element");
  const assetPath = /<path\b([^>]*?)\/?\s*>/i.exec(assetSvg[2]);
  assert.ok(assetPath !== null, "assets/limen-logo.svg has a <path> element");
  const expectedViewBox = attr(assetSvg[1], "viewBox");
  const expectedD = attr(assetPath[1], "d");
  assert.ok(expectedViewBox !== null && expectedViewBox.length > 0);
  assert.ok(expectedD !== null && expectedD.length > 0);

  const outDir = buildStation();
  try {
    assert.deepEqual(readdirSync(outDir, { recursive: true }), ["index.html"]);
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

    const headings = [...markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
    assert.equal(headings.length, 1, "one <h1> heading");
    const heading = headings[0][1];

    const svgsInHeading = [
      ...heading.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi),
    ];
    assert.equal(
      svgsInHeading.length,
      1,
      "exactly one <svg> inside the heading",
    );
    assert.equal(
      [...markup.matchAll(/<svg\b/gi)].length,
      1,
      "no extra <svg> outside the heading",
    );

    const [, svgAttrs, svgBody] = svgsInHeading[0];
    assert.equal(attr(svgAttrs, "role"), "img");
    assert.equal(attr(svgAttrs, "aria-label"), "limen");
    assert.equal(attr(svgAttrs, "viewBox"), expectedViewBox);

    const paths = [...svgBody.matchAll(/<path\b([^>]*?)\/?\s*>/gi)];
    assert.equal(paths.length, 1, "one <path> inside the logo <svg>");
    assert.equal(attr(paths[0][1], "fill"), "currentColor");
    assert.equal(attr(paths[0][1], "fill-rule"), "evenodd");
    assert.equal(attr(paths[0][1], "d"), expectedD);

    const textWithoutSvg = heading
      .replace(/<svg\b[\s\S]*?<\/svg>/i, "")
      .replace(/\s+/g, " ")
      .trim();
    assert.equal(
      textWithoutSvg,
      "Scan with to check in",
      "plain limen text is replaced by the logo",
    );

    const style = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(markup)?.[1] ?? "";
    assert.match(
      style,
      /h1\s+svg\s*\{[^}]*height:\s*[\d.]+em/i,
      "CSS sizes the logo to the heading",
    );
    assert.doesNotMatch(
      style,
      /\bfilter\s*:/i,
      "no CSS filter is used to recolour the logo",
    );

    assert.doesNotMatch(markup, /<(?:img|link|use)\b/i);
    assert.doesNotMatch(markup, /\b(?:src|href|xlink:href)\s*=/i);
    assert.doesNotMatch(html, /\s(?:src|href)="(?!data:)/i);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
