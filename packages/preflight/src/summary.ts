// What a transaction would do to the accounts the user controls (E-09,
// audited). Pure module: it reads the decoded instructions only. Simulated
// balance changes come from simulate.ts.
//
// The user is the transaction's fee payer, its first required signer, read
// from the transaction itself, so the app and a server summarize the same
// bytes the same way. "Yours" means an instruction the user's wallet
// authorizes: the wallet is the System funding account, the account being
// assigned, or a signing owner, delegate or authority of a token instruction.
// The summary writes the role marker "user" (marker.ts) wherever the user's
// address would appear, so it carries no wallet address.

import {
  messageAccounts,
  type Account,
  type LookupTables,
} from "./accounts.ts";
import {
  decodeInstruction,
  type Decoded,
  type TokenProgram,
  type UndecodedReason,
} from "./decode.ts";
import {
  cappedUnitLimit,
  MAX_COMPUTE_UNIT_LIMIT,
  priorityFeeLamports,
} from "./fee.ts";
import { withMarker } from "./marker.ts";
import type { ParsedTransaction } from "./wire.ts";

/** An account in the summary: its address, or where it sits when unknown. */
export type Place =
  | { readonly address: string }
  | { readonly table: string; readonly index: number };

export type Effect =
  | {
      readonly kind: "sol-out";
      readonly instruction: number;
      readonly to: Place;
      readonly lamports: string;
      /** create-account: the lamports fund a new account. */
      readonly reason: "transfer" | "create-account" | "derived-account";
    }
  | {
      readonly kind: "owner-assigned";
      readonly instruction: number;
      readonly newOwner: string;
    }
  | {
      readonly kind: "pays-for-token-account";
      readonly instruction: number;
      readonly account: Place;
    }
  | {
      readonly kind: "token-out";
      readonly instruction: number;
      readonly program: TokenProgram;
      readonly source: Place;
      readonly destination: Place;
      readonly mint: Place | null;
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      readonly kind: "delegate-approved";
      readonly instruction: number;
      readonly program: TokenProgram;
      readonly account: Place;
      readonly delegate: Place;
      readonly mint: Place | null;
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      readonly kind: "delegate-revoked";
      readonly instruction: number;
      readonly program: TokenProgram;
      readonly account: Place;
    }
  | {
      readonly kind: "authority-changed";
      readonly instruction: number;
      readonly program: TokenProgram;
      readonly account: Place;
      readonly authorityType: string;
      readonly newAuthority: string | null;
    }
  | {
      readonly kind: "account-closed";
      readonly instruction: number;
      readonly program: TokenProgram;
      readonly account: Place;
      readonly destination: Place;
    }
  | {
      readonly kind: "tokens-burned";
      readonly instruction: number;
      readonly program: TokenProgram;
      readonly account: Place;
      readonly mint: Place;
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      /** New tokens minted with the wallet's mint authority. */
      readonly kind: "tokens-minted";
      readonly instruction: number;
      readonly program: TokenProgram;
      readonly mint: Place;
      readonly destination: Place;
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      /** The fee payer's priority fee (fee.ts). */
      readonly kind: "priority-fee";
      /** The SetComputeUnitPrice instruction. */
      readonly instruction: number;
      readonly microLamportsPerUnit: string;
      /**
       * The SetComputeUnitLimit value after the runtime's cap, or null when
       * the transaction sets no limit and the runtime's default applies.
       */
      readonly unitLimit: number | null;
      /** The fee; with no limit set, the most it can be. */
      readonly lamports: string;
    };

export interface Undecoded {
  readonly instruction: number;
  readonly programId: string;
  readonly reason: UndecodedReason;
}

export interface Signers {
  /**
   * The fee payer, the first required signer: the wallet summarized for.
   * Always the role marker "user", never the address.
   */
  readonly feePayer: string;
  /** Every other required signer, and whether its signature is filled in. */
  readonly others: readonly {
    readonly address: string;
    readonly signed: boolean;
  }[];
  /** No signature in the transaction is filled in yet. */
  readonly unsigned: boolean;
}

export interface TransactionSummary {
  readonly effects: readonly Effect[];
  /**
   * Decoded instructions that the user's wallet does not authorize, each cut
   * to its index and kind.
   */
  readonly others: readonly {
    readonly instruction: number;
    readonly kind: Exclude<Decoded["kind"], "undecoded">;
  }[];
  /** Instructions the decoder could not decode. Any entry means the fallback card. */
  readonly undecoded: readonly Undecoded[];
  readonly signers: Signers;
  /** Accounts from lookup tables that were not loaded. */
  readonly unresolvedAccounts: number;
}

function place(account: Account): Place {
  if (account.address !== null) return { address: account.address };
  // messageAccounts gives every null address a lookup position.
  const lookup = account.lookup ?? { table: "", index: -1 };
  return { table: lookup.table, index: lookup.index };
}

function isUser(account: Account, user: string): boolean {
  return account.address === user;
}

/** A token instruction is the user's when the wallet signs as an authorizer. */
function authorizedByUser(
  authorizers: readonly Account[],
  user: string,
): boolean {
  return authorizers.some(
    (account) => account.signer && account.address === user,
  );
}

function effectOf(
  decoded: Decoded,
  instruction: number,
  user: string,
): Effect | null {
  switch (decoded.kind) {
    case "sol-transfer":
      return isUser(decoded.from, user)
        ? {
            kind: "sol-out",
            instruction,
            to: place(decoded.to),
            lamports: decoded.lamports,
            reason: "transfer",
          }
        : null;
    case "sol-transfer-with-seed":
      // The base account signs for an account derived from it.
      return isUser(decoded.base, user)
        ? {
            kind: "sol-out",
            instruction,
            to: place(decoded.to),
            lamports: decoded.lamports,
            reason: "derived-account",
          }
        : null;
    case "create-account":
      return isUser(decoded.funder, user)
        ? {
            kind: "sol-out",
            instruction,
            to: place(decoded.account),
            lamports: decoded.lamports,
            reason: "create-account",
          }
        : null;
    case "assign":
      return isUser(decoded.account, user)
        ? { kind: "owner-assigned", instruction, newOwner: decoded.owner }
        : null;
    case "create-token-account":
      return isUser(decoded.funder, user)
        ? {
            kind: "pays-for-token-account",
            instruction,
            account: place(decoded.account),
          }
        : null;
    case "token-transfer":
      return authorizedByUser(decoded.authorizers, user)
        ? {
            kind: "token-out",
            instruction,
            program: decoded.program,
            source: place(decoded.source),
            destination: place(decoded.destination),
            mint: decoded.mint === null ? null : place(decoded.mint),
            amount: decoded.amount,
            decimals: decoded.decimals,
          }
        : null;
    case "token-approve":
      return authorizedByUser(decoded.authorizers, user)
        ? {
            kind: "delegate-approved",
            instruction,
            program: decoded.program,
            account: place(decoded.source),
            delegate: place(decoded.delegate),
            mint: decoded.mint === null ? null : place(decoded.mint),
            amount: decoded.amount,
            decimals: decoded.decimals,
          }
        : null;
    case "token-revoke":
      return authorizedByUser(decoded.authorizers, user)
        ? {
            kind: "delegate-revoked",
            instruction,
            program: decoded.program,
            account: place(decoded.source),
          }
        : null;
    case "token-set-authority":
      return authorizedByUser(decoded.authorizers, user)
        ? {
            kind: "authority-changed",
            instruction,
            program: decoded.program,
            account: place(decoded.target),
            authorityType: decoded.authorityType,
            newAuthority: decoded.newAuthority,
          }
        : null;
    case "token-close-account":
      return authorizedByUser(decoded.authorizers, user)
        ? {
            kind: "account-closed",
            instruction,
            program: decoded.program,
            account: place(decoded.account),
            destination: place(decoded.destination),
          }
        : null;
    case "token-burn":
      return authorizedByUser(decoded.authorizers, user)
        ? {
            kind: "tokens-burned",
            instruction,
            program: decoded.program,
            account: place(decoded.account),
            mint: place(decoded.mint),
            amount: decoded.amount,
            decimals: decoded.decimals,
          }
        : null;
    case "token-mint-to":
      // Minting moves nothing out of the wallet's accounts, but it spends
      // the wallet's authority over the mint.
      return authorizedByUser(decoded.authorizers, user)
        ? {
            kind: "tokens-minted",
            instruction,
            program: decoded.program,
            mint: place(decoded.mint),
            destination: place(decoded.destination),
            amount: decoded.amount,
            decimals: decoded.decimals,
          }
        : null;
    case "advance-nonce":
    case "token-other":
    case "compute-budget":
    case "memo":
    case "undecoded":
      return null;
  }
}

/**
 * The priority fee, from the one SetComputeUnitPrice and at most one
 * SetComputeUnitLimit. With two of either the runtime fails the transaction
 * (DuplicateInstruction, fee.ts), and the summary gives no fee; it gives none
 * either when the fee is zero.
 */
function priorityFee(decoded: readonly Decoded[]): Effect | null {
  const budget = (name: string) =>
    decoded.flatMap((entry, instruction) =>
      entry.kind === "compute-budget" && entry.name === name
        ? [{ instruction, value: entry.value }]
        : [],
    );
  const prices = budget("SetComputeUnitPrice");
  const limits = budget("SetComputeUnitLimit");
  if (prices.length !== 1 || limits.length > 1) return null;
  const unitLimit =
    limits.length === 1 ? cappedUnitLimit(Number(limits[0].value)) : null;
  const lamports = priorityFeeLamports(
    prices[0].value,
    unitLimit ?? MAX_COMPUTE_UNIT_LIMIT,
  );
  if (lamports === "0") return null;
  return {
    kind: "priority-fee",
    instruction: prices[0].instruction,
    microLamportsPerUnit: prices[0].value,
    unitLimit,
    lamports,
  };
}

function isZero(signature: Uint8Array): boolean {
  return signature.every((byte) => byte === 0);
}

/**
 * Summarizes a parsed transaction for its fee payer. tables holds the lookup
 * tables read from the chain; an empty map leaves their addresses unresolved.
 */
export function summarizeTransaction(
  transaction: ParsedTransaction,
  tables: LookupTables,
): TransactionSummary {
  const { message, signatures } = transaction;
  const accounts = messageAccounts(message, tables);
  // wire.ts guarantees at least one static key and one required signer.
  const user = message.staticKeys[0];

  const effects: Effect[] = [];
  const others: TransactionSummary["others"][number][] = [];
  const undecoded: Undecoded[] = [];
  const decodedAll = message.instructions.map((compiled) =>
    decodeInstruction(compiled, accounts),
  );
  const fee = priorityFee(decodedAll);
  decodedAll.forEach((decoded, instruction) => {
    if (fee !== null && fee.instruction === instruction) {
      effects.push(fee);
      return;
    }
    if (decoded.kind === "undecoded") {
      undecoded.push({
        instruction,
        programId: decoded.programId,
        reason: decoded.reason,
      });
      return;
    }
    const effect = effectOf(decoded, instruction, user);
    if (effect === null) others.push({ instruction, kind: decoded.kind });
    else effects.push(effect);
  });

  const required = message.staticKeys.slice(
    0,
    message.header.numRequiredSignatures,
  );
  const signers: Signers = {
    feePayer: user,
    others: required
      .map((address, index) => ({
        address,
        signed: !isZero(signatures[index]),
      }))
      .filter((signer) => signer.address !== user),
    unsigned: signatures.every(isZero),
  };

  // The summary names the user's wallet only by its role, never its address.
  return withMarker(
    {
      effects,
      others,
      undecoded,
      signers,
      unresolvedAccounts: accounts.filter((account) => account.address === null)
        .length,
    },
    user,
  );
}
