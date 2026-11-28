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
// - hands-over: the wallet authorizes it, and it gives an address other than
//   the wallet control of the wallet's tokens or accounts (drain.ts, clause 1);
// - other: anything else, including what limen cannot tell from the
//   instruction alone;
// - not-decoded.
//
// A refused or no-effect instruction is never a hand-over. Sources, at the
// revisions decode.ts names: solana-program/token 38de8d1 and token-2022
// efe55b4, program/src/processor.rs; solana-program/associated-token-account
// 34509e4; anza-xyz/agave a64fa73 for the System program and the fee payer.

import type { Account } from "./accounts.ts";
import type { Decoded, TokenProgram } from "./decode.ts";
import { findProgramAddress } from "./pda.ts";
import { ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM } from "./programs.ts";

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
  | "not-derived-address";

/** How a card or a reason names the program that refuses. */
export const PROGRAM_NAME: Readonly<
  Record<TokenProgram | "associated-token", string>
> = {
  token: "the Token program",
  "token-2022": "Token-2022",
  "associated-token": "the associated token account program",
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
};

export type Verdict =
  | {
      readonly verdict: "refused";
      readonly program: TokenProgram | "associated-token";
      readonly refusal: Refusal;
    }
  | { readonly verdict: "no-effect" }
  | { readonly verdict: "hands-over" }
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
  const isWallet = (account: Account) => account.address === user;
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
        (authorized(decoded.authorizers) &&
        decoded.amount !== "0" &&
        !isWallet(decoded.delegate)
          ? HANDS_OVER
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
        (authorized(decoded.authorizers) && !isWallet(decoded.destination)
          ? HANDS_OVER
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
    case "token-other":
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
