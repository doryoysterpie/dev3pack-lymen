// The priority fee a transaction sets (E-09, m6). Pure module.
//
// From anza-xyz/agave at a64fa73:
// - compute-budget/src/compute_budget_limits.rs, lines 61 to 69: the fee is
//   the price, in micro-lamports per compute unit, times the compute unit
//   limit, divided by 1,000,000 and rounded up, and it saturates at the
//   largest u64.
// - compute-budget-instruction/src/compute_budget_instruction_details.rs,
//   lines 121 to 128: the limit is the one SetComputeUnitLimit asks for, or a
//   default the runtime works out, and either is capped at
//   MAX_COMPUTE_UNIT_LIMIT. Lines 155 to 186: a second SetComputeUnitLimit or
//   SetComputeUnitPrice fails the transaction with DuplicateInstruction.
// - program-runtime/src/execution_budget.rs, line 26: MAX_COMPUTE_UNIT_LIMIT
//   is 1,400,000.
//
// The default limit depends on which programs the instructions call and on
// the cluster's feature set (lines 196 to 219), so with no SetComputeUnitLimit
// the fee given here is the most it can be.

export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

const MICRO_LAMPORTS_PER_LAMPORT = BigInt(1_000_000);
const U64_MAX = BigInt("18446744073709551615");

/** The limit the runtime applies to a requested one. */
export function cappedUnitLimit(requested: number): number {
  return Math.min(requested, MAX_COMPUTE_UNIT_LIMIT);
}

/**
 * The priority fee in lamports, as a decimal string, for a price in
 * micro-lamports per compute unit (a decimal u64) and a compute unit limit.
 */
export function priorityFeeLamports(
  microLamportsPerUnit: string,
  unitLimit: number,
): string {
  const microLamports = BigInt(microLamportsPerUnit) * BigInt(unitLimit);
  const lamports =
    (microLamports + MICRO_LAMPORTS_PER_LAMPORT - BigInt(1)) /
    MICRO_LAMPORTS_PER_LAMPORT;
  return (lamports > U64_MAX ? U64_MAX : lamports).toString();
}
