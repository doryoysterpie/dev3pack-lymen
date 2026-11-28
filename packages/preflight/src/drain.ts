// The drain pattern (E-09), the first condition of D-05's auto-escalation
// threshold. This module is the one definition: E-11's threshold, E-15's
// claims table and the app's card read it, and the package README states it
// in words. D-05 names the condition without defining it; the owner adopted
// this definition with its false alarms kept (ruling 7a), and ruling 20a
// narrowed it to what limen takes from a simulation: the run's status and the
// wallet's SOL change from the run's own balances. So 7a's simulated
// token-sweep clause is gone, and with no account read before the
// simulation, so is its clause comparing the wallet's and its token
// accounts' owner, data length, delegate, allowance and close authority with
// such a read. A token drain inside a program limen does not decode shows
// only the flagged fallback card; token-sweep evidence returns as H-13.
//
// "A simulation that ran without an error" means one the pre-flight used
// (preflight.ts). Ownership in clause 1 is taken from the token programs' own
// authority rule (summary.ts, authorizedByUser).
//
// A ready report shows a drain pattern when, for the user's wallet (the
// transaction's fee payer, written "user" in the report), either holds:
//
// 1. Control handed over, in the decoded instructions: a delegate other than
//    the wallet approved over one of the wallet's token accounts; the wallet
//    account assigned to a program other than the System Program and the
//    wallet's own address; a token
//    account or mint authority moved to an address other than the wallet; or
//    a token account closed with its SOL sent to an address other than the
//    wallet.
// 2. A sweep of the wallet's SOL, in a simulation that ran without an error:
//    the wallet left with less than a tenth of the lamports it held, from the
//    run's own pre and post balances.
//
// A request whose fee payer is unset is checked as rebuilt with the user's
// wallet as fee payer (fee-payer.ts). A malformed transaction, a stop at a
// non-devnet endpoint, another wallet's transaction, a run with no wallet
// named, and a payment that leaves the wallet a tenth or more show no drain
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
      // The System Program already owns a wallet account, and the wallet's
      // own address is not another address (the audit of 21e1f9f, item 8).
      return (
        effect.newOwner !== SYSTEM_PROGRAM && effect.newOwner !== USER_MARKER
      );
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

/** Clause 2, for the wallet's simulated SOL change. */
export function drainingChange(change: BalanceChange): boolean {
  return swept(change.before, change.after);
}

export function drainPattern(report: PreflightReport): boolean {
  if (report.kind !== "ready") return false;
  const { summary, simulation } = report;
  if (summary.effects.some(handsOverControl)) return true;
  if (simulation.status !== "ran" || simulation.err !== null) return false;
  return simulation.changes.some(drainingChange);
}
