// A transaction request that leaves the fee payer unset (E-09, m13). Pure
// module.
//
// The Solana Pay specification (solana-foundation/pay 8e1b87c, SPEC.md, "POST
// Response") covers a transaction whose signatures are empty: the application
// should set the fee payer to the account in the request, or to the zero
// value, and the wallet must ignore the fee payer in the transaction and set
// it to the account in the request. limen does that for the zero value, so
// the card shows, the simulation runs and the wallet signs one transaction,
// with the user's wallet as its fee payer.
//
// The zero value is the key of 32 zero bytes, which is also the System
// Program's address. The message is rebuilt by these rules:
//
// - The user's wallet goes first, as the fee payer, a writable signer. If the
//   transaction already names it, it keeps that one place.
// - Every other static account keeps the role its place in the message gave
//   it, and the order within each role.
// - The zero key loses the fee payer's place. It stays as a read-only account
//   if an instruction runs it as a program. If an instruction names it as an
//   account, it keeps the writable signer role its place gave it, so the
//   rebuilt transaction needs a signature no wallet can give, and the
//   pre-flight holds it (cosigner-missing).
// - Account indexes are renumbered to match; indexes into lookup tables move
//   by the change in the number of static accounts.
// - Every signature is left empty, one per required signer.
//
// A transaction with any signature, or with another fee payer, is left as it
// was sent.

import { encodeTransaction } from "./encode.ts";
import { SYSTEM_PROGRAM } from "./programs.ts";
import { parseTransaction, type ParsedTransaction } from "./wire.ts";

/** The zero value the specification allows for an unset fee payer. */
export const UNSET_FEE_PAYER = SYSTEM_PROGRAM;

/**
 * The transaction, read with the zero key as its fee payer, when it leaves
 * the fee payer unset and carries no signature; otherwise null.
 */
export function readUnsetFeePayer(bytes: Uint8Array): ParsedTransaction | null {
  const parsed = parseTransaction(bytes, { feePayerUnset: true });
  if (!parsed.ok) return null;
  const { signatures, message } = parsed.transaction;
  if (message.staticKeys[0] !== UNSET_FEE_PAYER) return null;
  if (signatures.some((signature) => signature.some((byte) => byte !== 0))) {
    return null;
  }
  return parsed.transaction;
}

interface Entry {
  readonly address: string;
  readonly signer: boolean;
  readonly writable: boolean;
  /** The index in the message as sent; null for a wallet added as fee payer. */
  readonly was: number | null;
}

const group = (entry: Entry): number =>
  (entry.signer ? 0 : 2) + (entry.writable ? 0 : 1);

/** The transaction from readUnsetFeePayer, rebuilt with user as fee payer. */
export function withFeePayer(
  transaction: ParsedTransaction,
  user: string,
): Uint8Array {
  if (user === UNSET_FEE_PAYER) {
    throw new Error("withFeePayer: the zero key cannot pay the fee");
  }
  const { message } = transaction;
  const { header, staticKeys, instructions } = message;
  const count = staticKeys.length;
  const writableSigners =
    header.numRequiredSignatures - header.numReadonlySignedAccounts;
  const firstReadonly = count - header.numReadonlyUnsignedAccounts;
  const roleAt = (i: number): Entry => ({
    address: staticKeys[i],
    signer: i < header.numRequiredSignatures,
    writable:
      i < writableSigners ||
      (i >= header.numRequiredSignatures && i < firstReadonly),
    was: i,
  });

  const rest: Entry[] = [];
  const namedAsAccount = instructions.some((instruction) =>
    instruction.accountIndexes.includes(0),
  );
  const runAsProgram = instructions.some(
    (instruction) => instruction.programIdIndex === 0,
  );
  if (namedAsAccount) rest.push(roleAt(0));
  else if (runAsProgram) {
    rest.push({ ...roleAt(0), signer: false, writable: false });
  }
  for (let i = 1; i < count; i += 1) {
    if (staticKeys[i] !== user) rest.push(roleAt(i));
  }
  const was = staticKeys.indexOf(user);
  const payer: Entry = {
    address: user,
    signer: true,
    writable: true,
    was: was > 0 ? was : null,
  };
  // Array.prototype.sort is stable, so each role keeps the order it had.
  rest.sort((a, b) => group(a) - group(b));
  const entries = [payer, ...rest];

  const moved = new Map<number, number>();
  entries.forEach((entry, i) => {
    if (entry.was !== null) moved.set(entry.was, i);
  });
  const shift = entries.length - count;
  const renumber = (index: number): number => {
    if (index >= count) return index + shift;
    const to = moved.get(index);
    if (to === undefined) {
      throw new Error(`withFeePayer: account ${index} has no place`);
    }
    return to;
  };

  const signers = entries.filter((entry) => entry.signer);
  return encodeTransaction(
    signers.map(() => new Uint8Array(64)),
    {
      ...message,
      header: {
        numRequiredSignatures: signers.length,
        numReadonlySignedAccounts: signers.filter((entry) => !entry.writable)
          .length,
        numReadonlyUnsignedAccounts: entries.filter(
          (entry) => !entry.signer && !entry.writable,
        ).length,
      },
      staticKeys: entries.map((entry) => entry.address),
      instructions: instructions.map((instruction) => ({
        programIdIndex: renumber(instruction.programIdIndex),
        accountIndexes: instruction.accountIndexes.map(renumber),
        data: instruction.data,
      })),
    },
  );
}
