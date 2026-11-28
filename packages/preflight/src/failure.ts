// A failed run's error, as limen shows it (E-09; the owner's audit of
// 6c4e64e, Major 5). Pure module.
//
// limen shows only what it can state exactly: agave's TransactionError
// variant name and, for InstructionError, the failing instruction's index and
// the inner InstructionError variant name, with a Custom code only when the
// answer's text writes it as a whole number that fits a u32. Every name comes
// from the lists below, copied from the pinned sources, so no text the RPC
// wrote is shown as the runtime's error. Anything else is "detail not
// shown": a null field.
//
// How agave writes the error (anza-xyz/agave a64fa73,
// transaction-status-client-types/src/lib.rs:287 to :307, UiTransactionError):
// InstructionError as the pair [index, error], every other variant as serde
// writes an externally tagged enum, so a variant with no data is its name, a
// variant with data is an object with that one name as its only member. The
// variants are those of solana-transaction-error 4.1.0 (anza-xyz/solana-sdk
// 40b9883, transaction-error/src/lib.rs:32 to :165) and solana-instruction-
// error 3.1.0 (13ec001, instruction-error/src/lib.rs:55 to :232), the versions
// agave a64fa73's Cargo.lock names.

import {
  isJsonArray,
  isJsonObject,
  wholeUpTo,
  type JsonValue,
} from "./json.ts";

export interface RunError {
  /** agave's TransactionError variant name, or null: detail not shown. */
  readonly transactionError: string | null;
  /** InstructionError only: the failing instruction's index, from 0. */
  readonly instruction: number | null;
  /** InstructionError only: the inner InstructionError variant name. */
  readonly instructionError: string | null;
  /** InstructionError Custom only: the program's code, a u32. */
  readonly custom: number | null;
}

// TransactionError variants that carry no data.
const TRANSACTION_ERRORS: ReadonlySet<string> = new Set([
  "AccountInUse",
  "AccountLoadedTwice",
  "AccountNotFound",
  "ProgramAccountNotFound",
  "InsufficientFundsForFee",
  "InvalidAccountForFee",
  "AlreadyProcessed",
  "BlockhashNotFound",
  "CallChainTooDeep",
  "MissingSignatureForFee",
  "InvalidAccountIndex",
  "SignatureFailure",
  "InvalidProgramForExecution",
  "SanitizeFailure",
  "ClusterMaintenance",
  "AccountBorrowOutstanding",
  "WouldExceedMaxBlockCostLimit",
  "UnsupportedVersion",
  "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit",
  "WouldExceedAccountDataBlockLimit",
  "TooManyAccountLocks",
  "AddressLookupTableNotFound",
  "InvalidAddressLookupTableOwner",
  "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex",
  "InvalidRentPayingAccount",
  "WouldExceedMaxVoteCostLimit",
  "WouldExceedAccountDataTotalLimit",
  "MaxLoadedAccountsDataSizeExceeded",
  "InvalidLoadedAccountsDataSizeLimit",
  "ResanitizationNeeded",
  "UnbalancedTransaction",
  "ProgramCacheHitMaxLimit",
  "CommitCancelled",
  "BailOut",
]);

// InstructionError variants that carry no data; Custom(u32) is the only one
// that does.
const INSTRUCTION_ERRORS: ReadonlySet<string> = new Set([
  "GenericError",
  "InvalidArgument",
  "InvalidInstructionData",
  "InvalidAccountData",
  "AccountDataTooSmall",
  "InsufficientFunds",
  "IncorrectProgramId",
  "MissingRequiredSignature",
  "AccountAlreadyInitialized",
  "UninitializedAccount",
  "UnbalancedInstruction",
  "ModifiedProgramId",
  "ExternalAccountLamportSpend",
  "ExternalAccountDataModified",
  "ReadonlyLamportChange",
  "ReadonlyDataModified",
  "DuplicateAccountIndex",
  "ExecutableModified",
  "RentEpochModified",
  "NotEnoughAccountKeys",
  "AccountDataSizeChanged",
  "AccountNotExecutable",
  "AccountBorrowFailed",
  "AccountBorrowOutstanding",
  "DuplicateAccountOutOfSync",
  "InvalidError",
  "ExecutableDataModified",
  "ExecutableLamportChange",
  "ExecutableAccountNotRentExempt",
  "UnsupportedProgramId",
  "CallDepth",
  "MissingAccount",
  "ReentrancyNotAllowed",
  "MaxSeedLengthExceeded",
  "InvalidSeeds",
  "InvalidRealloc",
  "ComputationalBudgetExceeded",
  "PrivilegeEscalation",
  "ProgramEnvironmentSetupFailure",
  "ProgramFailedToComplete",
  "ProgramFailedToCompile",
  "Immutable",
  "IncorrectAuthority",
  "BorshIoError",
  "AccountNotRentExempt",
  "InvalidAccountOwner",
  "ArithmeticOverflow",
  "UnsupportedSysvar",
  "IllegalOwner",
  "MaxAccountsDataAllocationsExceeded",
  "MaxAccountsExceeded",
  "MaxInstructionTraceLengthExceeded",
  "BuiltinProgramsMustConsumeComputeUnits",
  "BailOut",
]);

const U8_MAX = 255;
const U32_MAX = 4294967295;

/** Every field not shown. */
export const DETAIL_NOT_SHOWN: RunError = Object.freeze({
  transactionError: null,
  instruction: null,
  instructionError: null,
  custom: null,
});

/** The one member of an object that has exactly one, or null. */
function onlyMember(
  value: JsonValue,
): readonly [name: string, value: JsonValue] | null {
  if (!isJsonObject(value) || value.size !== 1) return null;
  const [entry] = value.entries();
  return entry;
}

/** The InstructionError pair, [index, error], as far as it is agave's. */
function instructionError(pair: JsonValue): RunError {
  if (!isJsonArray(pair) || pair.length !== 2) return DETAIL_NOT_SHOWN;
  const index = wholeUpTo(pair[0], U8_MAX);
  if (index === null) return DETAIL_NOT_SHOWN;
  const shown = (name: string | null, custom: number | null): RunError => ({
    transactionError: "InstructionError",
    instruction: index,
    instructionError: name,
    custom,
  });
  const inner = pair[1];
  if (typeof inner === "string") {
    return shown(INSTRUCTION_ERRORS.has(inner) ? inner : null, null);
  }
  const member = onlyMember(inner);
  if (member !== null && member[0] === "Custom") {
    return shown("Custom", wholeUpTo(member[1], U32_MAX));
  }
  return shown(null, null);
}

/**
 * A failed run's err, from the answer as json.ts read it, cut to what limen
 * shows. Each null field is detail not shown.
 */
export function runError(err: JsonValue): RunError {
  if (typeof err === "string") {
    return TRANSACTION_ERRORS.has(err)
      ? { ...DETAIL_NOT_SHOWN, transactionError: err }
      : DETAIL_NOT_SHOWN;
  }
  const member = onlyMember(err);
  if (member === null) return DETAIL_NOT_SHOWN;
  const [name, data] = member;
  const named = { ...DETAIL_NOT_SHOWN, transactionError: name };
  switch (name) {
    case "InstructionError":
      return instructionError(data);
    // DuplicateInstruction(u8), transaction-error/src/lib.rs:131.
    case "DuplicateInstruction":
      return wholeUpTo(data, U8_MAX) === null ? DETAIL_NOT_SHOWN : named;
    // { account_index: u8 }, transaction-error/src/lib.rs:134 and :148.
    case "InsufficientFundsForRent":
    case "ProgramExecutionTemporarilyRestricted": {
      const field = onlyMember(data);
      return field !== null &&
        field[0] === "account_index" &&
        wholeUpTo(field[1], U8_MAX) !== null
        ? named
        : DETAIL_NOT_SHOWN;
    }
    default:
      return DETAIL_NOT_SHOWN;
  }
}
