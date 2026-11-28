// Whether a file lies inside a folder (E-03), by device and inode up its real path, so a symlink
// or ".." does not hide it (index.test.ts).
import { realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * True when the real path of `file` is inside `folder`. False when `folder` does not exist, as
 * when the API runs from a copy of its sources outside the repository.
 */
export function isInsideFolder(file: string, folder: string): boolean {
  let target: { dev: number; ino: number };
  try {
    target = statSync(folder);
  } catch {
    return false;
  }
  let current = dirname(realpathSync(file));
  for (;;) {
    const here = statSync(current);
    if (here.dev === target.dev && here.ino === target.ino) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
