// The drain pattern (E-09), the first condition of D-05's auto-escalation
// threshold. This function is the one definition; E-11's threshold and E-15's
// claims table read it, and the package README states it in words.
//
// A ready pre-flight shows a drain pattern when, for the user's wallet (the
// transaction's fee payer), any of these holds:
//
// 1. Control handed over, in the decoded instructions: a delegate approved
//    over one of the wallet's token accounts; the wallet account assigned to
//    another program; a token account or mint authority moved to an address
//    other than the wallet; or a token account closed with its SOL sent to an
//    address other than the wallet.
// 2. Control handed over, in a simulation that ran without an error: a token
//    account the wallet owned has a new delegate other than the wallet, or a
//    new owner other than the wallet.
// 3. A sweep, in a simulation that ran without an error: the wallet is left
//    with less than a tenth of its SOL, or a token account the wallet owns is
//    emptied without being closed.
//
// A malformed transaction, a stop at a non-devnet endpoint, and a plain
// payment that leaves the wallet a tenth or more of its SOL show no drain
// pattern.

import type { PreflightReport } from "./preflight.ts";
import type { Effect } from "./summary.ts";

/** A sweep leaves the wallet with less than 1 / SWEEP_DIVISOR of its SOL. */
export const SWEEP_DIVISOR = 10;

function handsOver(effect: Effect, user: string): boolean {
  switch (effect.kind) {
    case "delegate-approved":
    case "owner-assigned":
      return true;
    case "authority-changed":
      return effect.newAuthority !== null && effect.newAuthority !== user;
    case "account-closed":
      // An unloaded lookup address is not the wallet's own address.
      return (
        !("address" in effect.destination) ||
        effect.destination.address !== user
      );
    default:
      return false;
  }
}

export function drainPattern(report: PreflightReport): boolean {
  if (report.kind !== "ready") return false;
  const { summary, simulation } = report;
  const user = summary.signers.feePayer;

  if (summary.effects.some((effect) => handsOver(effect, user))) return true;

  if (simulation.status !== "ran" || simulation.err !== null) return false;
  return simulation.changes.some((change) => {
    if (change.kind === "sol") {
      const before = BigInt(change.before);
      const after = BigInt(change.after);
      return before > BigInt(0) && after * BigInt(SWEEP_DIVISOR) < before;
    }
    const newDelegate =
      change.delegateAfter !== null &&
      change.delegateAfter !== change.delegateBefore &&
      change.delegateAfter !== user;
    const newOwner = change.ownerAfter !== null && change.ownerAfter !== user;
    const emptied =
      change.ownerAfter !== null &&
      BigInt(change.before) > BigInt(0) &&
      change.after === "0";
    return newDelegate || newOwner || emptied;
  });
}
