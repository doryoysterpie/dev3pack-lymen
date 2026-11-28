// Whether a file lies inside a folder, judged on the file system rather than on path text (E-03).
// The organizer key must not sit inside apps/station, which the station page's dev server
// serves. The file's path is resolved through every symlink, then each folder above it is
// compared with the station folder by device and inode, so a symlink or ".." does not hide it
// (index.test.ts).
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
