// What each decoded instruction does, decided from its own arguments and
// accounts (E-09; the owner's audit of 6c4e64e, Majors 6 and 7). Pure module.
//
// This is the one decision: the card's rows (apps/mobile/src/tx/card-text.ts),
// the drain pattern's first clause (drain.ts) and the signing gate
// (preflight.ts) all read the verdicts summary.ts's instructionVerdicts gives
// from it. A verdict is one of:
//
// - refused: the program refuses the instruction whatever the accounts hold,
//   so the transaction cannot succeed;
// - no-effect: accepted, it moves nothing;
// - hands-over: the wallet authorizes it, and it gives a known address other
//   than the wallet control of the wallet's tokens or accounts (drain.ts,
//   clause 1);
// - unresolved-hand-over: the wallet authorizes an approval (over 0) or a
//   close whose delegate or destination sits in a lookup table limen did not
//   resolve, so limen could not tell whether that address is the wallet;
// - other: anything else, including what limen cannot tell from the
//   instruction alone;
// - not-decoded.
//
// A refused or no-effect instruction is never a hand-over. Sources, at the
// revisions decode.ts names: solana-program/token 38de8d1 and token-2022
// efe55b4, program/src/processor.rs; solana-program/associated-token-account
// 34509e4; anza-xyz/agave a64fa73 for the System program and the fee payer.

import type { Account } from "./accounts.ts";
import {
  parseComputeBudgetData,
  type ComputeBudgetData,
  type Decoded,
  type TokenProgram,
} from "./decode.ts";
import { findProgramAddress } from "./pda.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM,
} from "./programs.ts";
import type { ParsedMessage } from "./wire.ts";

/** Why a program refuses an instruction whatever the accounts hold. */
export type Refusal =
  /**
   * SetAuthority removing a token account's owner. Both programs refuse it
   * for a token account (token :449 to :453, token-2022 :786 to :794), and
   * refuse the AccountOwner type for a mint (:508 to :510, :1051 to :1053)
   * and for anything else (:513 to :515, :1055 to :1057).
   */
  | "owner-removed"
  /** CloseAccount into the account itself (token :677 to :679). */
  | "closed-into-itself"
  /**
   * One account named both where the program reads a token account and
   * where it reads a mint: no account is both (Account::LEN 165 and
   * Mint::LEN 82, token interface/src/state.rs:132 and :38, read by
   * Pack::unpack, solana-program-pack 3.1.0, anza-xyz/solana-sdk f5f84f3,
   * program-pack/src/lib.rs:50 to :53; token-2022 by its own unpack). Token
   * TransferChecked :246, :247, :264; ApproveChecked :362, :373 (token-2022
   * :667, :681); MintTo :532, :544 (token-2022 :1080, :1093); Burn :598,
   * :599 (token-2022 :1187, :1228).
   */
  | "account-as-mint"
  /**
   * The wallet's own account named where the program reads a token account
   * or a mint. The fee payer is a System account, with no data or a nonce
   * account's (agave a64fa73, svm/src/account_loader.rs:366 to :372 and
   * :379 to :393), which
   * the Token program's unpack refuses by its length and Token-2022 by its
   * owner (check_program_account, token-2022 :186, :653, :714, :755, :1075,
   * :1168, :1505 and :1585). It
   * holds only while no earlier instruction could have changed the wallet's
   * account (instructionVerdicts).
   */
  | "wallet-as-token-state"
  /**
   * An associated token account creation whose account is not the address
   * derived from its wallet, token program and mint
   * (associated-token-account 34509e4, program/src/processor.rs:77 to :86;
   * interface/src/address.rs:61 to :75).
   */
  | "not-derived-address"
  /**
   * Compute budget data the runtime cannot read as one of its four
   * instructions: none, a kind it does not have, or too short for its kind
   * (agave a64fa73, compute-budget-instruction/src
   * /compute_budget_instruction_details.rs:155 to :186).
   */
  | "compute-budget-data"
  /** A second compute budget instruction of one kind (the same lines). */
  | "compute-budget-duplicate"
  /**
   * A heap frame that is not a multiple of 1024 from 32768 to 262144 bytes
   * (:105 to :119, :192 to :194; program-runtime/src/execution_budget.rs:35
   * and :36; HEAP_LENGTH in solana-program-entrypoint 3.1.1,
   * anza-xyz/solana-sdk 19945d3, program-entrypoint/src/lib.rs:39).
   */
  | "heap-frame-size"
  /** A loaded accounts data size limit of 0 (:141). */
  | "data-size-limit-zero";

/** How a card or a reason names the program that refuses. */
export const PROGRAM_NAME: Readonly<
  Record<TokenProgram | "associated-token" | "runtime", string>
> = {
  token: "the Token program",
  "token-2022": "Token-2022",
  "associated-token": "the associated token account program",
  runtime: "the runtime",
};

/** What a refused instruction asks for, as a card or a reason says it. */
export const REFUSAL_WHY: Readonly<Record<Refusal, string>> = {
  "owner-removed": "removing a token account's owner",
  "closed-into-itself": "closing an account into itself",
  "account-as-mint": "one account as both a token account and a mint",
  "wallet-as-token-state":
    "the wallet's own account as a token account or mint",
  "not-derived-address":
    "an associated token account other than the address derived from its wallet, token program and mint",
  "compute-budget-data": "compute budget data it cannot read",
  "compute-budget-duplicate": "a second compute budget instruction of one kind",
  "heap-frame-size":
    "a heap frame that is not a multiple of 1024 from 32768 to 262144 bytes",
  "data-size-limit-zero": "a loaded accounts data size limit of 0",
};

export type Verdict =
  | {
      readonly verdict: "refused";
      readonly program: TokenProgram | "associated-token" | "runtime";
      readonly refusal: Refusal;
    }
  | { readonly verdict: "no-effect" }
  | { readonly verdict: "hands-over" }
  | {
      readonly verdict: "unresolved-hand-over";
      readonly table: string;
      readonly index: number;
    }
  | { readonly verdict: "other" }
  | { readonly verdict: "not-decoded" };

/** A verdict for the instruction at its index in the message. */
export type InstructionVerdict = Verdict & { readonly instruction: number };

const OTHER: Verdict = { verdict: "other" };
const NO_EFFECT: Verdict = { verdict: "no-effect" };
const HANDS_OVER: Verdict = { verdict: "hands-over" };

/** Whether two accounts are one, as far as the message shows. */
function same(a: Account, b: Account): boolean {
  if (a.address !== null && b.address !== null) return a.address === b.address;
  return (
    a.lookup !== null &&
    b.lookup !== null &&
    a.lookup.table === b.lookup.table &&
    a.lookup.index === b.lookup.index
  );
}

/**
 * The verdict for one decoded instruction. user is the wallet, the fee
 * payer. walletIsSystemAccount says no earlier instruction in the
 * transaction could have changed the wallet's account (instructionVerdicts).
 */
export function instructionEffect(
  decoded: Decoded,
  user: string,
  walletIsSystemAccount: boolean,
): Verdict {
  const isWallet = (account: Account) =>
    account.address !== null && account.address === user;
  // Never negate isWallet on an Account whose address may be null: an
  // unresolved lookup entry is neither known to be the wallet nor known to be
  // another address (the audit of ac1ce67, Major 1).
  const handOverTo = (target: Account): Verdict => {
    if (target.address !== null) {
      return target.address === user ? OTHER : HANDS_OVER;
    }
    const lookup = target.lookup ?? { table: "", index: -1 };
    return {
      verdict: "unresolved-hand-over",
      table: lookup.table,
      index: lookup.index,
    };
  };
  // The wallet is the authority a token instruction names, and signs
  // (summary.ts, authorizedByUser).
  const authorized = (authorizers: readonly Account[]) =>
    authorizers.length > 0 && authorizers[0].signer && isWallet(authorizers[0]);
  const refused = (
    program: TokenProgram | "associated-token",
    refusal: Refusal,
  ): Verdict => ({ verdict: "refused", program, refusal });
  // The accounts a token instruction reads as token accounts and as mints.
  const tokenState = (
    program: TokenProgram,
    tokenAccounts: readonly Account[],
    mints: readonly Account[],
  ): Verdict | null => {
    if (tokenAccounts.some((a) => mints.some((m) => same(a, m)))) {
      return refused(program, "account-as-mint");
    }
    if (walletIsSystemAccount && [...tokenAccounts, ...mints].some(isWallet)) {
      return refused(program, "wallet-as-token-state");
    }
    return null;
  };
  switch (decoded.kind) {
    // A transfer to the account it comes from takes the lamports off and
    // puts them back (agave a64fa73, programs/system/src/system_processor.rs
    // :216 to :243).
    case "sol-transfer":
    case "sol-transfer-with-seed":
      return same(decoded.from, decoded.to) ? NO_EFFECT : OTHER;
    // Assign, and CreateAccount of the wallet's own address, give the
    // wallet account to the program they name (system_processor.rs:117 to
    // :182). The decoder decodes no Assign to the System Program, and the
    // wallet's own address is not another address.
    case "assign":
      return isWallet(decoded.account) && decoded.owner !== user
        ? HANDS_OVER
        : OTHER;
    case "create-account":
      return isWallet(decoded.account) &&
        decoded.owner !== SYSTEM_PROGRAM &&
        decoded.owner !== user
        ? HANDS_OVER
        : OTHER;
    case "create-token-account": {
      const keys = [decoded.wallet, decoded.tokenProgram, decoded.mint];
      if (decoded.account.address === null) return OTHER;
      if (keys.some((key) => key.address === null)) return OTHER;
      const derived = findProgramAddress(
        keys.map((key) => key.address ?? ""),
        ASSOCIATED_TOKEN_PROGRAM,
      );
      return derived !== null && derived !== decoded.account.address
        ? refused("associated-token", "not-derived-address")
        : OTHER;
    }
    case "token-transfer":
      // A transfer to the account it comes from returns before any amount
      // moves (token :270 to :311).
      return (
        tokenState(
          decoded.program,
          [decoded.source, decoded.destination],
          decoded.mint === null ? [] : [decoded.mint],
        ) ?? (same(decoded.source, decoded.destination) ? NO_EFFECT : OTHER)
      );
    case "token-approve":
      // A delegate approved for 0 base units can move none (token :281;
      // token-2022 :511), so an approval of 0 hands over nothing.
      return (
        tokenState(
          decoded.program,
          [decoded.source],
          decoded.mint === null ? [] : [decoded.mint],
        ) ??
        (authorized(decoded.authorizers) && decoded.amount !== "0"
          ? handOverTo(decoded.delegate)
          : OTHER)
      );
    case "token-revoke":
      return tokenState(decoded.program, [decoded.source], []) ?? OTHER;
    case "token-set-authority":
      if (
        decoded.authorityType === "AccountOwner" &&
        decoded.newAuthority === null
      ) {
        return refused(decoded.program, "owner-removed");
      }
      // The target is a token account or a mint; the wallet is neither.
      if (walletIsSystemAccount && isWallet(decoded.target)) {
        return refused(decoded.program, "wallet-as-token-state");
      }
      return authorized(decoded.authorizers) &&
        decoded.newAuthority !== null &&
        decoded.newAuthority !== user
        ? HANDS_OVER
        : OTHER;
    case "token-close-account":
      if (same(decoded.account, decoded.destination)) {
        return refused(decoded.program, "closed-into-itself");
      }
      return (
        tokenState(decoded.program, [decoded.account], []) ??
        (authorized(decoded.authorizers)
          ? handOverTo(decoded.destination)
          : OTHER)
      );
    case "token-burn":
      return (
        tokenState(decoded.program, [decoded.account], [decoded.mint]) ?? OTHER
      );
    case "token-mint-to":
      return (
        tokenState(decoded.program, [decoded.destination], [decoded.mint]) ??
        OTHER
      );
    // InitializeAccount, SyncNative, InitializeAccount3 and
    // InitializeImmutableOwner each read their first account as a token
    // account (token :104, :760 and :808; token-2022 :186, :1505 and :1585).
    case "token-initialize-account":
    case "token-sync-native":
    case "token-initialize-account-3":
    case "token-initialize-immutable-owner":
      return tokenState(decoded.program, [decoded.account], []) ?? OTHER;
    case "advance-nonce":
    case "compute-budget":
    case "memo":
      return OTHER;
    case "undecoded":
      return { verdict: "not-decoded" };
  }
}

/**
 * Whether an instruction could change the wallet account's owner or data,
 * after which the wallet is no longer known to be a System account: one
 * limen does not decode, which may call the System program with the wallet's
 * signature, or an Assign or CreateAccount that may name the wallet.
 */
export function mayChangeWallet(decoded: Decoded, user: string): boolean {
  switch (decoded.kind) {
    case "undecoded":
      return true;
    case "assign":
    case "create-account":
      return (
        decoded.account.address === null || decoded.account.address === user
      );
    default:
      return false;
  }
}

/**
 * The compute budget instructions the runtime refuses from their data
 * alone, by index, read through decode.ts's parseComputeBudgetData as the
 * runtime reads the message's compute budget instructions before any runs
 * (compute_budget_instruction_details.rs:54 to :98, :101 to :153 and :155
 * to :186). A refusal fails the whole transaction.
 */
export function computeBudgetRefusals(
  message: ParsedMessage,
): Map<number, Refusal> {
  const refusals = new Map<number, Refusal>();
  const seen = new Set<ComputeBudgetData["name"]>();
  message.instructions.forEach((instruction, index) => {
    if (
      message.staticKeys[instruction.programIdIndex] !== COMPUTE_BUDGET_PROGRAM
    ) {
      return;
    }
    const parsed = parseComputeBudgetData(instruction.data);
    if (parsed === null) {
      refusals.set(index, "compute-budget-data");
      return;
    }
    if (seen.has(parsed.name)) {
      refusals.set(index, "compute-budget-duplicate");
      return;
    }
    seen.add(parsed.name);
    if (
      parsed.name === "RequestHeapFrame" &&
      !(
        parsed.value >= 32 * 1024 &&
        parsed.value <= 256 * 1024 &&
        parsed.value % 1024 === 0
      )
    ) {
      refusals.set(index, "heap-frame-size");
    }
    if (
      parsed.name === "SetLoadedAccountsDataSizeLimit" &&
      parsed.value === 0
    ) {
      refusals.set(index, "data-size-limit-zero");
    }
  });
  return refusals;
}
