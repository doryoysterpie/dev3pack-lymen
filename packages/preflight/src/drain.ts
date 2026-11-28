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
// (preflight.ts). Clause 1 reads the one verdict effect.ts gives each decoded
// instruction, the verdict the card and the signing gate read too (the
// owner's audit of 6c4e64e, Majors 6 and 7).
//
// A ready report shows a drain pattern when, for the user's wallet (the
// transaction's fee payer, written "user" in the report), either holds:
//
// 1. Control handed over, in the decoded instructions: an instruction the
//    wallet authorizes whose verdict is hands-over. That is a delegate other
//    than the wallet approved for more than 0 base units over a token
//    account; the wallet account assigned, or created anew, for a program
//    other than the System Program and the wallet's own address; a token
//    account or mint authority moved to an address other than the wallet;
//    or a token account closed with its SOL sent to an address other than
//    the wallet. An instruction its program refuses whatever the accounts
//    hold, such as a close into the account itself, or one that moves
//    nothing, is never a hand-over.
// 2. A sweep of the wallet's SOL, in a simulation that ran without an error:
//    the wallet left with less than a tenth of the lamports it held, from the
//    run's own pre and post balances.
//
// A request whose fee payer is unset is checked as rebuilt with the user's
// wallet as fee payer (fee-payer.ts). A malformed transaction, a stop at a
// non-devnet endpoint, another wallet's transaction, a run with no wallet
// named, and a payment that leaves the wallet a tenth or more show no drain
// pattern.

import type { InstructionVerdict } from "./effect.ts";
import type { PreflightReport } from "./preflight.ts";
import type { BalanceChange } from "./simulate.ts";

/** A sweep leaves less than 1 / SWEEP_DIVISOR of what an account held. */
export const SWEEP_DIVISOR = 10;

/**
 * Clause 1: an instruction that hands control of the wallet's tokens or
 * accounts to another address, by its verdict. The card reads this same
 * test.
 */
export function handsOverControl(verdict: InstructionVerdict): boolean {
  return verdict.verdict === "hands-over";
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
  const { simulation } = report;
  if (report.verdicts.some(handsOverControl)) return true;
  if (simulation.status !== "ran" || simulation.err !== null) return false;
  return simulation.changes.some(drainingChange);
}
