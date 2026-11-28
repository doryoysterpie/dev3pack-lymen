// What the pre-flight takes from a devnet simulation (E-09), narrowed by the
// owner's ruling 20a: the run's status and the wallet's SOL change, from that
// same run's own pre and post balances at the wallet's index. limen reads no
// account before or after the simulation (only the lookup tables decoding
// needs), so it takes no token account change, owner or data from a run.

import type { Account } from "./accounts.ts";

/**
 * The wallet's SOL in a simulation that ran without an error: lamports before
 * and after, from the run's own preBalances and postBalances at the wallet's
 * index, 0, since the fee payer is always the message's first account
 * (anza-xyz/agave a64fa73, svm/src/transaction_balances.rs:80 to :94 lists
 * one balance per account key, in order). account is the wallet's role
 * marker, "user".
 */
export interface BalanceChange {
  readonly kind: "sol";
  readonly account: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Why a simulation result cannot be used for this message, or null. An
 * address behind a lookup table limen could not read is unknown, so the run's
 * balances cannot be matched to the message's keys.
 */
export function watchProblem(accounts: readonly Account[]): string | null {
  return accounts.some((account) => account.address === null)
    ? "an address comes from a lookup table limen could not read"
    : null;
}

/**
 * The wallet's SOL change in a clean run, or none when the run leaves it as
 * it was. pre and post are the run's own balances, one per account key.
 */
export function walletSolChange(
  user: string,
  pre: readonly string[],
  post: readonly string[],
): BalanceChange[] {
  return pre[0] === post[0]
    ? []
    : [{ kind: "sol", account: user, before: pre[0], after: post[0] }];
}
