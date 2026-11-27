// isMainModule: the entry check every command-line script in services/api uses.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./main-module.ts";

test("a script reached through a symlinked file or directory counts as the main module", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-main-"));
  try {
    const real = join(dir, "script.ts");
    writeFileSync(real, "");
    const linkFile = join(dir, "link.ts");
    symlinkSync(real, linkFile);
    const linkDir = join(dir, "linked-dir");
    symlinkSync(dir, linkDir);
    // Node gives a module its symlink-resolved URL.
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    assert.equal(isMainModule(moduleUrl, real), true);
    assert.equal(isMainModule(moduleUrl, linkFile), true);
    assert.equal(isMainModule(moduleUrl, join(linkDir, "script.ts")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another file, a missing file or no argv[1] does not count", () => {
  const dir = mkdtempSync(join(tmpdir(), "limen-main-"));
  try {
    const real = join(dir, "script.ts");
    const other = join(dir, "other.ts");
    writeFileSync(real, "");
    writeFileSync(other, "");
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    assert.equal(isMainModule(moduleUrl, other), false);
    assert.equal(isMainModule(moduleUrl, join(dir, "missing.ts")), false);
    assert.equal(isMainModule(moduleUrl, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
