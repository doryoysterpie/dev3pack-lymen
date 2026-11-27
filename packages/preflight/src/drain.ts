// The drain pattern (E-09), the first condition of D-05's auto-escalation
// threshold. This module is the one definition: E-11's threshold, E-15's
// claims table and the app's card read it, and the package README states it
// in words. The definition is limen's; D-05 names the condition without
// defining it, so it is held for the owner.
//
// A ready report shows a drain pattern when, for the user's wallet (the
// transaction's fee payer, written "user" in the report), any of these holds:
//
// 1. Control handed over, in the decoded instructions: a delegate other than
//    the wallet approved over one of the wallet's token accounts; the wallet
//    account assigned to a program other than the System Program; a token
//    account or mint authority moved to an address other than the wallet; or
//    a token account closed with its SOL sent to an address other than the
//    wallet.
// 2. Control handed over, in a simulation that ran without an error: the
//    wallet account given a new owner program or a different data length; or
//    a token account the wallet owned given a new delegate other than the
//    wallet, a raised allowance for a delegate other than the wallet, a new
//    owner other than the wallet, or a new close authority other than the
//    wallet.
// 3. A sweep, in a simulation that ran without an error: the wallet, or a
//    token account the wallet owned, left with less than a tenth of what it
//    held, closing included.
//
// A request whose fee payer is unset is checked as rebuilt with the user's
// wallet as fee payer (fee-payer.ts). A malformed transaction, a stop at a
// non-devnet endpoint, another wallet's transaction, a run with no wallet
// named, and a payment that leaves each account a tenth or more show no drain
// pattern.

import { USER_MARKER } from "./marker.ts";
import { SYSTEM_PROGRAM } from "./programs.ts";
import type { PreflightReport } from "./preflight.ts";
import type { BalanceChange } from "./simulate.ts";
import type { Effect } from "./summary.ts";

/** A sweep leaves less than 1 / SWEEP_DIVISOR of what an account held. */
export const SWEEP_DIVISOR = 10;

/**
 * Clause 1: a decoded effect that hands control of the user's tokens or
 * accounts to another address. The card uses this same test.
 */
export function handsOverControl(effect: Effect): boolean {
  switch (effect.kind) {
    case "delegate-approved":
      // An unloaded lookup address is not the wallet's own address.
      return (
        !("address" in effect.delegate) ||
        effect.delegate.address !== USER_MARKER
      );
    case "owner-assigned":
      // The System Program already owns a wallet account.
      return effect.newOwner !== SYSTEM_PROGRAM;
    case "authority-changed":
      return (
        effect.newAuthority !== null && effect.newAuthority !== USER_MARKER
      );
    case "account-closed":
      // An unloaded lookup address is not the wallet's own address.
      return (
        !("address" in effect.destination) ||
        effect.destination.address !== USER_MARKER
      );
    default:
      return false;
  }
}

function swept(before: string, after: string): boolean {
  const had = BigInt(before);
  return had > BigInt(0) && BigInt(after) * BigInt(SWEEP_DIVISOR) < had;
}

const other = (address: string | null): boolean =>
  address !== null && address !== USER_MARKER;

/** Clauses 2 and 3, for one simulated change. */
export function drainingChange(change: BalanceChange): boolean {
  if (change.kind === "sol") {
    const newOwner =
      change.ownerBefore !== null &&
      change.ownerAfter !== null &&
      change.ownerBefore !== change.ownerAfter;
    const newData = change.dataLengthBefore !== change.dataLengthAfter;
    return newOwner || newData || swept(change.before, change.after);
  }
  const newDelegate =
    other(change.delegateAfter) &&
    change.delegateAfter !== change.delegateBefore;
  const raisedAllowance =
    other(change.delegateAfter) &&
    change.delegateAfter === change.delegateBefore &&
    BigInt(change.delegatedAmountAfter) > BigInt(change.delegatedAmountBefore);
  const newOwner = other(change.ownerAfter);
  const newCloseAuthority =
    other(change.closeAuthorityAfter) &&
    change.closeAuthorityAfter !== change.closeAuthorityBefore;
  return (
    newDelegate ||
    raisedAllowance ||
    newOwner ||
    newCloseAuthority ||
    swept(change.before, change.after)
  );
}

export function drainPattern(report: PreflightReport): boolean {
  if (report.kind !== "ready") return false;
  const { summary, simulation } = report;
  if (summary.effects.some(handsOverControl)) return true;
  if (simulation.status !== "ran" || simulation.err !== null) return false;
  return simulation.changes.some(drainingChange);
}
