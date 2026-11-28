// Whether a module is the script Node was started with. Node resolves symlinks in a module's own
// URL but not in process.argv[1], so both sides are compared as real paths: a run through a
// symlinked path, such as /tmp on macOS, still counts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when the module at `moduleUrl` is the file `argv1` names, after resolving symlinks. */
export function isMainModule(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
