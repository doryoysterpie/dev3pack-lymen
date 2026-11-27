// Balance changes from a simulation (E-09). Pure module: it compares account
// state read before the simulation with the state the simulation reports
// after it, for the user's wallet and the token accounts the wallet owns.

import type { Account } from "./accounts.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./programs.ts";
import type { AccountState } from "./rpc.ts";
import { parseTokenAccount } from "./state.ts";

export type BalanceChange =
  | {
      readonly kind: "sol";
      readonly account: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "token";
      readonly account: string;
      readonly mint: string;
      readonly before: string;
      /** "0" when the simulation closed the account. */
      readonly after: string;
      readonly delegateBefore: string | null;
      readonly delegateAfter: string | null;
      readonly delegatedAmountAfter: string;
      /** The owner after the simulation, or null when it closed the account. */
      readonly ownerAfter: string | null;
    };

/** The simulateTransaction accounts list is capped like getMultipleAccounts. */
export const MAX_WATCHED = 100;

/**
 * The accounts to read before and after: the user's wallet first, then every
 * writable account with a known address, without repeats, up to MAX_WATCHED.
 */
export function watchedAddresses(
  user: string,
  accounts: readonly Account[],
): string[] {
  const out = [user];
  for (const account of accounts) {
    if (out.length >= MAX_WATCHED) break;
    if (
      account.writable &&
      account.address !== null &&
      !out.includes(account.address)
    ) {
      out.push(account.address);
    }
  }
  return out;
}

function isTokenProgram(owner: string): boolean {
  return owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM;
}

/** Lists what changed for the user, in the order of the watched addresses. */
export function balanceChanges(
  user: string,
  addresses: readonly string[],
  before: readonly (AccountState | null)[],
  after: readonly (AccountState | null)[],
): BalanceChange[] {
  const changes: BalanceChange[] = [];
  addresses.forEach((address, i) => {
    const pre = before[i] ?? null;
    const post = after[i] ?? null;
    if (address === user) {
      const lamportsBefore = pre?.lamports ?? "0";
      const lamportsAfter = post?.lamports ?? "0";
      if (lamportsBefore !== lamportsAfter) {
        changes.push({
          kind: "sol",
          account: address,
          before: lamportsBefore,
          after: lamportsAfter,
        });
      }
      return;
    }
    if (pre === null || !isTokenProgram(pre.owner)) return;
    const was = parseTokenAccount(pre.data);
    if (was === null || was.owner !== user) return;
    const now =
      post !== null && isTokenProgram(post.owner)
        ? parseTokenAccount(post.data)
        : null;
    const change: BalanceChange = {
      kind: "token",
      account: address,
      mint: was.mint,
      before: was.amount,
      after: now?.amount ?? "0",
      delegateBefore: was.delegate,
      delegateAfter: now?.delegate ?? null,
      delegatedAmountAfter: now?.delegatedAmount ?? "0",
      ownerAfter: now?.owner ?? null,
    };
    if (
      change.before !== change.after ||
      change.delegateBefore !== change.delegateAfter ||
      was.delegatedAmount !== change.delegatedAmountAfter ||
      change.ownerAfter !== user
    ) {
      changes.push(change);
    }
  });
  return changes;
}
