// Balance changes from a simulation (E-09). Pure module. The amounts, the
// wallet's SOL and each token account's balance, before and after, come from
// the simulation's own run (its pre and post balances), so they cannot hold a
// transaction that landed between a read and the simulation. Each token
// balance must agree with the account state the run returns and with the
// read, or the run is not used. A transaction with no token program among
// its accounts cannot change a token account, and the run lists no token
// balances, so no token change is listed for it, and a run that shows one
// changed is not used (balanceChanges). The rest, the wallet's owner and
// data length and each token account's delegate, allowance, owner and close
// authority, compares account state read before the simulation with the
// state the simulation reports after it; the pre-flight uses that only when
// a second read, after the simulation, agrees with the first
// (unchangedBetween).

import type { Account } from "./accounts.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./programs.ts";
import type { AccountState, TokenBalance } from "./rpc.ts";
import { parseTokenAccount, type TokenAccount } from "./state.ts";

export type BalanceChange =
  | {
      readonly kind: "sol";
      /** The user's wallet. */
      readonly account: string;
      readonly before: string;
      readonly after: string;
      /** The program that owns the wallet account; null when it is absent. */
      readonly ownerBefore: string | null;
      readonly ownerAfter: string | null;
      /** The wallet account's data length in bytes; 0 when it is absent. */
      readonly dataLengthBefore: number;
      readonly dataLengthAfter: number;
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
      readonly delegatedAmountBefore: string;
      readonly delegatedAmountAfter: string;
      /** The owner after the simulation, or null when it closed the account. */
      readonly ownerAfter: string | null;
      readonly closeAuthorityBefore: string | null;
      readonly closeAuthorityAfter: string | null;
    };

/**
 * The fields of a change that come from the read before the simulation, not
 * from the simulation's own run; the matching After fields are the run's
 * account state. So a change in one of them may come from another
 * transaction that landed between that read and the simulation, even when a
 * second read after the simulation agrees with the first.
 */
export const FROM_READ_BEFORE = [
  "ownerBefore",
  "dataLengthBefore",
  "delegateBefore",
  "delegatedAmountBefore",
  "closeAuthorityBefore",
] as const;

/** The simulateTransaction accounts list is capped like getMultipleAccounts. */
export const MAX_WATCHED = 100;

/** The simulation's own balances, for every account the transaction lists. */
export interface SimulatedBalances {
  /** The transaction's account list in index order; null where unknown. */
  readonly keys: readonly (string | null)[];
  readonly pre: readonly string[];
  readonly post: readonly string[];
  readonly preToken: readonly TokenBalance[];
  readonly postToken: readonly TokenBalance[];
}

/**
 * Why the watched accounts would not cover every account the transaction can
 * write, or null when they do: a writable account behind a lookup table that
 * could not be read, or more writable accounts than MAX_WATCHED.
 */
export function watchProblem(
  user: string,
  accounts: readonly Account[],
): string | null {
  if (
    accounts.some((account) => account.writable && account.address === null)
  ) {
    return "a writable account comes from a lookup table limen could not read";
  }
  const writable = new Set(
    accounts
      .filter((account) => account.writable && account.address !== null)
      .map((account) => account.address),
  );
  writable.add(user);
  return writable.size > MAX_WATCHED
    ? `the transaction writes to more than ${MAX_WATCHED} accounts, more than limen watches`
    : null;
}

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

/** Why a run's token balances are not used: they disagree with the read. */
const READ_STATE =
  "the simulation's token balances do not match the accounts read";
/** Why: they disagree with the run's own account state. */
const OWN_STATE =
  "the simulation's token balances do not match its own account state";

/** Whether two token account states agree on everything but the amount. */
function sameState(a: TokenAccount, b: TokenAccount): boolean {
  return (
    a.mint === b.mint &&
    a.owner === b.owner &&
    a.delegate === b.delegate &&
    a.delegatedAmount === b.delegatedAmount &&
    a.closeAuthority === b.closeAuthority
  );
}

/**
 * The watched token accounts the user owns, before the simulation or after
 * it, in the order of the watched addresses. after is empty when the
 * simulation did not run.
 */
export function ownedTokenAccounts(
  user: string,
  addresses: readonly string[],
  before: readonly (AccountState | null)[],
  after: readonly (AccountState | null)[],
): string[] {
  const owned = (state: AccountState | null | undefined): boolean =>
    state !== null &&
    state !== undefined &&
    isTokenProgram(state.owner) &&
    parseTokenAccount(state.data)?.owner === user;
  return addresses.filter(
    (address, i) => address !== user && (owned(before[i]) || owned(after[i])),
  );
}

/**
 * Whether two reads of the same addresses agree on everything the changes
 * compare apart from amounts: which accounts exist, their owner program and
 * data length, and for a token account its mint, owner, delegate, allowance
 * and close authority.
 */
export function unchangedBetween(
  first: readonly (AccountState | null)[],
  second: readonly (AccountState | null)[],
): boolean {
  if (first.length !== second.length) return false;
  return first.every((a, i) => {
    const b = second[i] ?? null;
    if (a === null || b === null) return a === b;
    if (a.owner !== b.owner || a.data.length !== b.data.length) return false;
    if (!isTokenProgram(a.owner)) return true;
    const x = parseTokenAccount(a.data);
    const y = parseTokenAccount(b.data);
    if (x === null || y === null) return x === y;
    return (
      x.mint === y.mint &&
      x.owner === y.owner &&
      x.delegate === y.delegate &&
      x.delegatedAmount === y.delegatedAmount &&
      x.closeAuthority === y.closeAuthority
    );
  });
}

/** Lists what changed for the user, in the order of the watched addresses. */
export function balanceChanges(
  user: string,
  addresses: readonly string[],
  before: readonly (AccountState | null)[],
  after: readonly (AccountState | null)[],
  balances: SimulatedBalances,
): BalanceChange[] {
  const indexOf = (address: string): number => {
    const index = balances.keys.indexOf(address);
    if (index < 0 || index >= balances.pre.length) {
      throw new Error(
        "the simulation's balances do not list a watched account",
      );
    }
    return index;
  };
  // The simulation lists token balances only when a token program is among
  // the transaction's accounts (anza-xyz/agave a64fa73,
  // svm/src/transaction_balances.rs:83 and :96). Without one, no instruction
  // can reach a token program (program-runtime/src/invoke_context.rs:463 to
  // 470), and only a token account's owner program can change its data
  // (transaction-context/src/instruction_accounts.rs:345 to 352), so the
  // account is as the read found it. An address behind a lookup table limen
  // could not read may be a token program.
  const holdsTokenProgram = balances.keys.some(
    (key) => key === null || isTokenProgram(key),
  );
  const changes: BalanceChange[] = [];
  addresses.forEach((address, i) => {
    const pre = before[i] ?? null;
    const post = after[i] ?? null;
    if (address === user) {
      // The wallet's SOL, and also who owns it and how much data it holds:
      // a program that takes ownership of the wallet controls its SOL.
      const index = indexOf(address);
      const change: BalanceChange = {
        kind: "sol",
        account: address,
        before: balances.pre[index],
        after: balances.post[index],
        ownerBefore: pre?.owner ?? null,
        ownerAfter: post?.owner ?? null,
        dataLengthBefore: pre?.data.length ?? 0,
        dataLengthAfter: post?.data.length ?? 0,
      };
      if (
        change.before !== change.after ||
        change.ownerBefore !== change.ownerAfter ||
        change.dataLengthBefore !== change.dataLengthAfter
      ) {
        changes.push(change);
      }
      return;
    }
    const was =
      pre !== null && isTokenProgram(pre.owner)
        ? parseTokenAccount(pre.data)
        : null;
    const readOwned = was !== null && was.owner === user;
    // The run's own account state: a token account, or not one any more,
    // since a closed account is handed to the System Program with no data
    // (solana-program/token 38de8d1, program/src/processor.rs:1042 to 1045).
    const postIsToken = post !== null && isTokenProgram(post.owner);
    const now = postIsToken ? parseTokenAccount(post.data) : null;
    if (!holdsTokenProgram) {
      if (!readOwned) return;
      // Nothing in the transaction can change the account (see above), so a
      // run that shows it changed is not evidence about this transaction.
      if (now === null || !sameState(was, now)) throw new Error(OWN_STATE);
      return;
    }
    const index = indexOf(address);
    // The run's own pre balance names the owner as the run starts. The
    // account is the wallet's only when that and the read agree, with one
    // entry for its mint; any disagreement leaves the run unused.
    const preEntries = balances.preToken.filter(
      (balance) => balance.accountIndex === index,
    );
    if (!readOwned && !preEntries.some((balance) => balance.owner === user)) {
      return;
    }
    const preBalance = preEntries[0];
    if (
      !readOwned ||
      preEntries.length !== 1 ||
      preBalance.owner !== user ||
      preBalance.mint !== was.mint
    ) {
      throw new Error(READ_STATE);
    }
    // Each post balance must agree with the account the run returns: one
    // entry with its mint, owner and amount for a token account, none for a
    // closed one. agave leaves an entry out when it cannot read the mint
    // (svm/src/transaction_balances.rs:96 to 104), so a missing entry does
    // not show the account closed.
    const postEntries = balances.postToken.filter(
      (balance) => balance.accountIndex === index,
    );
    if (postIsToken) {
      const postBalance = postEntries[0];
      if (
        now === null ||
        now.mint !== was.mint ||
        postEntries.length !== 1 ||
        postBalance.mint !== now.mint ||
        postBalance.owner !== now.owner ||
        postBalance.amount !== now.amount
      ) {
        throw new Error(OWN_STATE);
      }
    } else if (postEntries.length !== 0) {
      throw new Error(OWN_STATE);
    }
    const amountBefore = preBalance.amount;
    // A closed account has no balance after.
    const amountAfter = now?.amount ?? "0";
    const change: BalanceChange = {
      kind: "token",
      account: address,
      mint: was.mint,
      before: amountBefore,
      after: amountAfter,
      delegateBefore: was.delegate,
      delegateAfter: now?.delegate ?? null,
      delegatedAmountBefore: was.delegatedAmount,
      delegatedAmountAfter: now?.delegatedAmount ?? "0",
      ownerAfter: now?.owner ?? null,
      closeAuthorityBefore: was.closeAuthority,
      closeAuthorityAfter: now?.closeAuthority ?? null,
    };
    if (
      change.before !== change.after ||
      change.delegateBefore !== change.delegateAfter ||
      change.delegatedAmountBefore !== change.delegatedAmountAfter ||
      change.ownerAfter !== user ||
      change.closeAuthorityBefore !== change.closeAuthorityAfter
    ) {
      changes.push(change);
    }
  });
  return changes;
}
