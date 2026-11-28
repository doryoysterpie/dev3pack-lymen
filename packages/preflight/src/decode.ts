// Instruction decoder (E-09, audited). Pure module.
//
// Layouts come from the program sources, pinned:
// - System: anza-xyz/solana-sdk 7b382f6, system-interface/src/instruction.rs.
//   bincode: a u32 little-endian variant index, then the fields.
// - SPL Token: solana-program/token 38de8d1, interface/src/instruction.rs.
// - Token-2022: solana-program/token-2022 efe55b4, interface/src/instruction.rs
//   (same tags 0 to 24, more authority types, Batch is tag 255).
// - Associated Token Account: solana-program/associated-token-account 34509e4,
//   program/src/processor.rs (empty data is Create).
// - Compute Budget: anza-xyz/solana-sdk 7b382f6,
//   compute-budget-interface/src/lib.rs (borsh: a u8 tag, then the value).
//
// The decoder is stricter than the programs: for each instruction it decodes,
// data of any length other than the exact one is "unexpected-data", never
// decoded. The base token instructions it only names (TOKEN_NAMED) carry no
// field the summary reads, and are named only at their exact data length and
// with at least their accounts, like the rest. Anything it cannot decode
// comes back as "undecoded" with a reason, so the card can say so instead of
// guessing.

import type { Account } from "./accounts.ts";
import * as programs from "./programs.ts";
import { encodeBase58 } from "./base58.ts";
import type { CompiledInstruction } from "./wire.ts";

export type TokenProgram = "token" | "token-2022";

export type UndecodedReason =
  | "unknown-program"
  | "instruction-not-decoded"
  | "unexpected-data"
  | "invalid-data"
  | "missing-accounts";

export type Decoded =
  | {
      readonly kind: "sol-transfer";
      readonly from: Account;
      readonly to: Account;
      readonly lamports: string;
    }
  | {
      readonly kind: "sol-transfer-with-seed";
      readonly from: Account;
      readonly base: Account;
      readonly to: Account;
      readonly lamports: string;
    }
  | {
      readonly kind: "assign";
      readonly account: Account;
      readonly owner: string;
    }
  | {
      readonly kind: "create-account";
      readonly funder: Account;
      readonly account: Account;
      readonly lamports: string;
      readonly owner: string;
    }
  | {
      readonly kind: "advance-nonce";
      readonly nonce: Account;
      readonly authority: Account;
    }
  | {
      readonly kind: "token-transfer";
      readonly program: TokenProgram;
      readonly source: Account;
      readonly destination: Account;
      readonly mint: Account | null;
      /** The owner or delegate, then any multisig signers. */
      readonly authorizers: readonly Account[];
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      readonly kind: "token-approve";
      readonly program: TokenProgram;
      readonly source: Account;
      readonly delegate: Account;
      readonly mint: Account | null;
      readonly authorizers: readonly Account[];
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      readonly kind: "token-revoke";
      readonly program: TokenProgram;
      readonly source: Account;
      readonly authorizers: readonly Account[];
    }
  | {
      readonly kind: "token-set-authority";
      readonly program: TokenProgram;
      readonly target: Account;
      readonly authorizers: readonly Account[];
      readonly authorityType: string;
      readonly newAuthority: string | null;
    }
  | {
      readonly kind: "token-close-account";
      readonly program: TokenProgram;
      readonly account: Account;
      readonly destination: Account;
      readonly authorizers: readonly Account[];
    }
  | {
      readonly kind: "token-burn";
      readonly program: TokenProgram;
      readonly account: Account;
      readonly mint: Account;
      readonly authorizers: readonly Account[];
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      readonly kind: "token-mint-to";
      readonly program: TokenProgram;
      readonly mint: Account;
      readonly destination: Account;
      /** The mint authority, then any multisig signers. */
      readonly authorizers: readonly Account[];
      readonly amount: string;
      readonly decimals: number | null;
    }
  | {
      readonly kind: "token-other";
      readonly program: TokenProgram;
      readonly name: string;
      /** The token account each named instruction takes first. */
      readonly account: Account;
    }
  | {
      readonly kind: "create-token-account";
      readonly idempotent: boolean;
      readonly funder: Account;
      readonly account: Account;
      readonly wallet: Account;
      readonly mint: Account;
      /** The token program the account is for, the instruction's sixth. */
      readonly tokenProgram: Account;
    }
  | {
      readonly kind: "compute-budget";
      readonly name: string;
      readonly value: string;
    }
  | {
      readonly kind: "memo";
      /** The memo when every byte is printable ASCII, otherwise null. */
      readonly text: string | null;
      readonly length: number;
    }
  | {
      readonly kind: "undecoded";
      readonly programId: string;
      readonly reason: UndecodedReason;
    };

function undecoded(programId: string, reason: UndecodedReason): Decoded {
  return { kind: "undecoded", programId, reason };
}

function u32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Whether bytes are UTF-8 as Rust's String::from_utf8 accepts it: no
 * overlong form, no surrogate, nothing past U+10FFFF.
 */
export function isUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    if (lead < 0x80) {
      i += 1;
      continue;
    }
    let follow: number;
    let least: number;
    let point: number;
    if (lead >= 0xc2 && lead <= 0xdf) {
      [follow, least, point] = [1, 0x80, lead & 0x1f];
    } else if (lead >= 0xe0 && lead <= 0xef) {
      [follow, least, point] = [2, 0x800, lead & 0x0f];
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      [follow, least, point] = [3, 0x10000, lead & 0x07];
    } else {
      return false;
    }
    if (i + follow >= bytes.length) return false;
    for (let k = 1; k <= follow; k += 1) {
      const next = bytes[i + k];
      if ((next & 0xc0) !== 0x80) return false;
      point = point * 64 + (next & 0x3f);
    }
    if (point < least || point > 0x10ffff) return false;
    if (point >= 0xd800 && point <= 0xdfff) return false;
    i += follow + 1;
  }
  return true;
}

/** A u64 read little-endian, as a decimal string. */
function u64(data: Uint8Array, offset: number): string {
  let value = BigInt(0);
  for (let i = 7; i >= 0; i -= 1) {
    value = value * BigInt(256) + BigInt(data[offset + i]);
  }
  return value.toString();
}

// System instruction variant indexes, in enum order.
const SYSTEM_CREATE_ACCOUNT = 0;
const SYSTEM_ASSIGN = 1;
const SYSTEM_TRANSFER = 2;
const SYSTEM_ADVANCE_NONCE = 4;
const SYSTEM_TRANSFER_WITH_SEED = 11;

function decodeSystem(data: Uint8Array, accounts: readonly Account[]): Decoded {
  const id = programs.SYSTEM_PROGRAM;
  if (data.length < 4) return undecoded(id, "unexpected-data");
  const variant = u32(data, 0);
  switch (variant) {
    case SYSTEM_CREATE_ACCOUNT:
      // lamports u64, space u64, owner address.
      if (data.length !== 4 + 8 + 8 + 32)
        return undecoded(id, "unexpected-data");
      if (accounts.length < 2) return undecoded(id, "missing-accounts");
      return {
        kind: "create-account",
        funder: accounts[0],
        account: accounts[1],
        lamports: u64(data, 4),
        owner: encodeBase58(data.subarray(20, 52)),
      };
    case SYSTEM_ASSIGN:
      if (data.length !== 4 + 32) return undecoded(id, "unexpected-data");
      if (accounts.length < 1) return undecoded(id, "missing-accounts");
      // Assigning an account to the System Program, which already owns a
      // wallet account, can change nothing; limen does not decode it.
      if (encodeBase58(data.subarray(4, 36)) === programs.SYSTEM_PROGRAM) {
        return undecoded(id, "instruction-not-decoded");
      }
      return {
        kind: "assign",
        account: accounts[0],
        owner: encodeBase58(data.subarray(4, 36)),
      };
    case SYSTEM_TRANSFER:
      if (data.length !== 4 + 8) return undecoded(id, "unexpected-data");
      if (accounts.length < 2) return undecoded(id, "missing-accounts");
      return {
        kind: "sol-transfer",
        from: accounts[0],
        to: accounts[1],
        lamports: u64(data, 4),
      };
    case SYSTEM_ADVANCE_NONCE:
      if (data.length !== 4) return undecoded(id, "unexpected-data");
      if (accounts.length < 3) return undecoded(id, "missing-accounts");
      return {
        kind: "advance-nonce",
        nonce: accounts[0],
        authority: accounts[2],
      };
    case SYSTEM_TRANSFER_WITH_SEED: {
      // lamports u64, from_seed String (u64 length, then bytes), from_owner.
      if (data.length < 4 + 8 + 8) return undecoded(id, "unexpected-data");
      const seedLength = BigInt(u64(data, 12));
      if (BigInt(data.length) !== BigInt(4 + 8 + 8 + 32) + seedLength) {
        return undecoded(id, "unexpected-data");
      }
      // from_seed is a Rust String (solana-sdk 7b382f6,
      // system-interface/src/instruction.rs:268): its bytes must be UTF-8.
      if (!isUtf8(data.subarray(20, 20 + Number(seedLength)))) {
        return undecoded(id, "invalid-data");
      }
      if (accounts.length < 3) return undecoded(id, "missing-accounts");
      return {
        kind: "sol-transfer-with-seed",
        from: accounts[0],
        base: accounts[1],
        to: accounts[2],
        lamports: u64(data, 4),
      };
    }
    default:
      return undecoded(id, "instruction-not-decoded");
  }
}

// SetAuthority authority types, by index. Token has the first four.
const AUTHORITY_TYPES = [
  "MintTokens",
  "FreezeAccount",
  "AccountOwner",
  "CloseAccount",
  "TransferFeeConfig",
  "WithheldWithdraw",
  "CloseMint",
  "InterestRate",
  "PermanentDelegate",
  "ConfidentialTransferMint",
  "TransferHookProgramId",
  "ConfidentialTransferFeeConfig",
  "MetadataPointer",
  "GroupPointer",
  "GroupMemberPointer",
  "ScaledUiAmount",
  "Pause",
  "PermissionedBurn",
];
const TOKEN_AUTHORITY_TYPE_COUNT = 4;

// Tags shown by name only, at their exact data length and with their
// accounts (solana-program/token 38de8d1, interface/src/instruction.rs,
// unpack at lines 571, 626, 627 and 646). None of them moves tokens, changes
// an authority or freezes an account. Every other tag not decoded below,
// FreezeAccount and ThawAccount among them, goes to the fallback card.
const TOKEN_NAMED: Readonly<
  Record<number, readonly [name: string, length: number, accounts: number]>
> = {
  1: ["InitializeAccount", 1, 4],
  17: ["SyncNative", 1, 1],
  18: ["InitializeAccount3", 33, 2],
  22: ["InitializeImmutableOwner", 1, 1],
};

// Token-2022 tags limen does not decode, though their layout is the Token
// program's: a transfer can credit less than its amount (a transfer fee) or
// call another program (a transfer hook), and CloseAccount can close a mint
// (solana-program/token-2022 efe55b4, program/src/processor.rs:574, :611,
// :1339). Only the mint's extensions would show which.
const TOKEN_2022_NOT_DECODED: ReadonlySet<number> = new Set([3, 9, 12]);

function decodeToken(
  program: TokenProgram,
  data: Uint8Array,
  accounts: readonly Account[],
): Decoded {
  const id =
    program === "token" ? programs.TOKEN_PROGRAM : programs.TOKEN_2022_PROGRAM;
  if (data.length === 0) return undecoded(id, "unexpected-data");
  const tag = data[0];
  if (program === "token-2022" && TOKEN_2022_NOT_DECODED.has(tag)) {
    return undecoded(id, "instruction-not-decoded");
  }

  // Exact data length and the fewest accounts each decoded tag takes.
  const shape = (
    length: number,
    minAccounts: number,
  ): UndecodedReason | null =>
    data.length !== length
      ? "unexpected-data"
      : accounts.length < minAccounts
        ? "missing-accounts"
        : null;

  switch (tag) {
    case 3: // Transfer: source, destination, authority
    case 12: {
      // TransferChecked: source, mint, destination, authority
      const checked = tag === 12;
      const problem = checked ? shape(10, 4) : shape(9, 3);
      if (problem) return undecoded(id, problem);
      return {
        kind: "token-transfer",
        program,
        source: accounts[0],
        destination: checked ? accounts[2] : accounts[1],
        mint: checked ? accounts[1] : null,
        authorizers: accounts.slice(checked ? 3 : 2),
        amount: u64(data, 1),
        decimals: checked ? data[9] : null,
      };
    }
    case 4: // Approve: source, delegate, owner
    case 13: {
      // ApproveChecked: source, mint, delegate, owner
      const checked = tag === 13;
      const problem = checked ? shape(10, 4) : shape(9, 3);
      if (problem) return undecoded(id, problem);
      return {
        kind: "token-approve",
        program,
        source: accounts[0],
        delegate: checked ? accounts[2] : accounts[1],
        mint: checked ? accounts[1] : null,
        authorizers: accounts.slice(checked ? 3 : 2),
        amount: u64(data, 1),
        decimals: checked ? data[9] : null,
      };
    }
    case 5: {
      // Revoke: source, owner
      const problem = shape(1, 2);
      if (problem) return undecoded(id, problem);
      return {
        kind: "token-revoke",
        program,
        source: accounts[0],
        authorizers: accounts.slice(1),
      };
    }
    case 6: {
      // SetAuthority: account or mint, current authority.
      // Data: tag, authority type, then COption<address>: 0, or 1 and 32 bytes.
      if (data.length !== 3 && data.length !== 35) {
        return undecoded(id, "unexpected-data");
      }
      const typeIndex = data[1];
      const typeCount =
        program === "token"
          ? TOKEN_AUTHORITY_TYPE_COUNT
          : AUTHORITY_TYPES.length;
      if (typeIndex >= typeCount) return undecoded(id, "invalid-data");
      const option = data[2];
      if (option !== 0 && option !== 1) return undecoded(id, "invalid-data");
      if (
        !(option === 0 && data.length === 3) &&
        !(option === 1 && data.length === 35)
      ) {
        return undecoded(id, "unexpected-data");
      }
      if (accounts.length < 2) return undecoded(id, "missing-accounts");
      return {
        kind: "token-set-authority",
        program,
        target: accounts[0],
        authorizers: accounts.slice(1),
        authorityType: AUTHORITY_TYPES[typeIndex],
        newAuthority: option === 1 ? encodeBase58(data.subarray(3, 35)) : null,
      };
    }
    case 7: // MintTo: mint, destination, mint authority
    case 14: {
      // MintToChecked: same accounts, plus decimals in the data.
      const checked = tag === 14;
      const problem = checked ? shape(10, 3) : shape(9, 3);
      if (problem) return undecoded(id, problem);
      return {
        kind: "token-mint-to",
        program,
        mint: accounts[0],
        destination: accounts[1],
        authorizers: accounts.slice(2),
        amount: u64(data, 1),
        decimals: checked ? data[9] : null,
      };
    }
    case 8: // Burn: account, mint, authority
    case 15: {
      // BurnChecked: same accounts, plus decimals in the data.
      const checked = tag === 15;
      const problem = checked ? shape(10, 3) : shape(9, 3);
      if (problem) return undecoded(id, problem);
      return {
        kind: "token-burn",
        program,
        account: accounts[0],
        mint: accounts[1],
        authorizers: accounts.slice(2),
        amount: u64(data, 1),
        decimals: checked ? data[9] : null,
      };
    }
    case 9: {
      // CloseAccount: account, destination, owner
      const problem = shape(1, 3);
      if (problem) return undecoded(id, problem);
      return {
        kind: "token-close-account",
        program,
        account: accounts[0],
        destination: accounts[1],
        authorizers: accounts.slice(2),
      };
    }
    default: {
      const named = TOKEN_NAMED[tag];
      if (named !== undefined) {
        const [name, length, minAccounts] = named;
        const problem = shape(length, minAccounts);
        if (problem) return undecoded(id, problem);
        return { kind: "token-other", program, name, account: accounts[0] };
      }
      // Token-2022 extension instructions (25 and up), Batch (255) and
      // anything else.
      return undecoded(id, "instruction-not-decoded");
    }
  }
}

function decodeAssociatedToken(
  data: Uint8Array,
  accounts: readonly Account[],
): Decoded {
  const id = programs.ASSOCIATED_TOKEN_PROGRAM;
  const tag = data.length === 0 ? 0 : data.length === 1 ? data[0] : -1;
  if (tag !== 0 && tag !== 1) {
    // RecoverNested (2) moves tokens and is not decoded.
    return undecoded(
      id,
      data.length > 1 ? "unexpected-data" : "instruction-not-decoded",
    );
  }
  if (accounts.length < 6) return undecoded(id, "missing-accounts");
  return {
    kind: "create-token-account",
    idempotent: tag === 1,
    funder: accounts[0],
    account: accounts[1],
    wallet: accounts[2],
    mint: accounts[3],
    tokenProgram: accounts[5],
  };
}

const COMPUTE_BUDGET: Readonly<Record<number, readonly [string, number]>> = {
  1: ["RequestHeapFrame", 4],
  2: ["SetComputeUnitLimit", 4],
  3: ["SetComputeUnitPrice", 8],
  4: ["SetLoadedAccountsDataSizeLimit", 4],
};

function decodeComputeBudget(data: Uint8Array): Decoded {
  const id = programs.COMPUTE_BUDGET_PROGRAM;
  const entry = data.length > 0 ? COMPUTE_BUDGET[data[0]] : undefined;
  if (entry === undefined) return undecoded(id, "instruction-not-decoded");
  const [name, width] = entry;
  if (data.length !== 1 + width) return undecoded(id, "unexpected-data");
  return {
    kind: "compute-budget",
    name,
    value: width === 8 ? u64(data, 1) : String(u32(data, 1)),
  };
}

function decodeMemo(data: Uint8Array): Decoded {
  const printable = data.every((byte) => byte >= 0x20 && byte <= 0x7e);
  return {
    kind: "memo",
    text: printable ? String.fromCharCode(...data) : null,
    length: data.length,
  };
}

/**
 * Decodes one compiled instruction. accounts is the message's full account
 * list from messageAccounts; the instruction's own accounts are picked from it.
 */
export function decodeInstruction(
  instruction: CompiledInstruction,
  accounts: readonly Account[],
): Decoded {
  // Program ids are static keys (wire.ts refuses anything else), so the
  // address is never null here.
  const programId = accounts[instruction.programIdIndex].address ?? "";
  const own = instruction.accountIndexes.map((index) => accounts[index]);
  const data = instruction.data;
  switch (programId) {
    case programs.SYSTEM_PROGRAM:
      return decodeSystem(data, own);
    case programs.TOKEN_PROGRAM:
      return decodeToken("token", data, own);
    case programs.TOKEN_2022_PROGRAM:
      return decodeToken("token-2022", data, own);
    case programs.ASSOCIATED_TOKEN_PROGRAM:
      return decodeAssociatedToken(data, own);
    case programs.COMPUTE_BUDGET_PROGRAM:
      return decodeComputeBudget(data);
    case programs.MEMO_PROGRAM:
    case programs.MEMO_V1_PROGRAM:
      return decodeMemo(data);
    default:
      return undecoded(programId, "unknown-program");
  }
}
