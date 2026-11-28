// Transaction-request card text (E-09). App strings live here so the copy
// rules (rule 9) can be checked in one place.

import {
  drainPattern,
  handsOverControl,
  PROGRAM_NAME,
  REFUSAL_WHY,
  toReport,
  type BalanceChange,
  type Effect,
  type InstructionVerdict,
  type Place,
  type Preflight,
  type RunError,
  type SignBlock,
  type SimulationOutcome,
  type TransactionSummary,
  type UndecodedReason,
  USER_MARKER,
} from "@limen/preflight";

import { URL } from "whatwg-url-minimum";

import { asWritten, type CardRow, type CardText } from "../pay/card-text.ts";

const U64_MAX = "18446744073709551615";

/** A base-unit amount with the given decimals, trailing zeros dropped. */
export function withDecimals(amount: string, decimals: number): string {
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

const sol = (lamports: string) => `${withDecimals(lamports, 9)} SOL`;

// The summary writes the role marker in place of the user's wallet address.
const shown = (address: string): string =>
  address === USER_MARKER ? "your wallet" : address;

// The pre-flight resolves a lookup table's addresses only with a
// simulation result it uses (the audit of 6c4e64e, Major 2), so an address
// it leaves unresolved may come from a table it read; the card says only
// that it does not show it.
const unread = (place: { table: string; index: number }): string =>
  `address in lookup table ${place.table} (index ${place.index}) that limen does not show`;

function where(place: Place): string {
  return "address" in place ? shown(place.address) : `an ${unread(place)}`;
}

const capitalized = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * A token amount as the instruction carries it: base units, and the
 * decimals a checked instruction states, which the program checks against
 * the mint. No token quantity is worked out from them: a mint's extensions,
 * such as an interest-bearing or scaled UI amount, can show another one
 * (the audit of 6c4e64e, Major 8; solana-program/token-2022 efe55b4,
 * program/src/processor.rs:1605 to :1617).
 */
function tokenAmount(amount: string, decimals: number | null): string {
  return decimals === null
    ? `${amount} base units`
    : `${amount} base units (the instruction expects a mint with ${decimals} decimals)`;
}

// What each authority type is called; a Token-2022 extension's authority
// goes by its type's name.
const AUTHORITY: Readonly<Record<string, string>> = {
  AccountOwner: "owner",
  CloseAccount: "close authority",
  MintTokens: "mint authority",
  FreezeAccount: "freeze authority",
};

/**
 * One row per decoded effect, each starting "Asks": an instruction alone
 * cannot show that it is accepted or what it changes, so a row states an
 * outcome only where its verdict (effect.ts, the one the drain pattern and
 * the signing gate read) is that the program refuses it whatever the
 * accounts hold, or that it moves nothing if accepted. limen reads no
 * account (ruling 20a), so no token account is called the wallet's.
 */
function effectRow(
  effect: Effect,
  verdict: InstructionVerdict | undefined,
): CardRow {
  if (verdict?.verdict === "refused") return refusedRow(effect, verdict);
  const moves = verdict?.verdict !== "no-effect";
  switch (effect.kind) {
    case "sol-out":
      return effect.reason === "create-account"
        ? {
            label: "Pays to create an account",
            value: `Asks your wallet to pay ${sol(effect.lamports)} into new account ${where(effect.to)}.`,
          }
        : {
            // A transfer to the account it comes from moves nothing.
            label: moves ? "Sends SOL" : "Sends SOL to the same account",
            value:
              effect.reason === "derived-account"
                ? `Asks to send ${sol(effect.lamports)} from an account derived from your wallet to ${moves ? where(effect.to) : "that same account"}${moves ? "." : ", which moves no SOL if accepted."}`
                : `Asks to send ${sol(effect.lamports)} from your wallet to ${where(effect.to)}${moves ? "." : ", which moves no SOL if accepted."}`,
          };
    case "owner-assigned":
      // The summary writes the wallet's own address as "user"; naming it as a
      // program would read "program user" (the audit of 21e1f9f, item 8).
      if (effect.newOwner === USER_MARKER) {
        return {
          label: "Assigns your wallet account",
          value:
            "Asks to make your wallet's own address the owner program of your wallet account.",
        };
      }
      return {
        label: "Hands over your wallet account",
        value: `Asks to assign your wallet account to program ${effect.newOwner}, which would then control its SOL.`,
      };
    case "pays-for-token-account":
      // The wallet pays only what the account lacks of its rent, and an
      // idempotent create does nothing when the account exists.
      return effect.idempotent
        ? {
            label: "May create a token account",
            value: `Asks to create token account ${where(effect.account)} if it does not exist yet, with your wallet paying up to its rent.`,
          }
        : {
            label: "Creates a token account",
            value: `Asks your wallet to pay up to the rent for new token account ${where(effect.account)}.`,
          };
    case "token-out":
      // A transfer to the account it comes from returns before any amount
      // moves (solana-program/token 38de8d1, program/src/processor.rs:270 to
      // :311), if its checks pass, which the instruction does not show.
      if (!moves) {
        return {
          label: "Transfers to the same account",
          value: `Asks to transfer ${tokenAmount(effect.amount, effect.decimals)} from token account ${where(effect.source)} to itself, which moves no tokens if accepted.`,
        };
      }
      return {
        label: "Sends tokens",
        value: `Asks to send ${tokenAmount(effect.amount, effect.decimals)}${effect.mint === null ? "" : ` of mint ${where(effect.mint)}`} from token account ${where(effect.source)} to ${where(effect.destination)}.`,
      };
    case "delegate-approved": {
      const who = where(effect.delegate);
      // limen reads no account (ruling 20a), so no token account is called
      // the wallet's.
      const from = `from token account ${where(effect.account)}. Your wallet signs as the owner the instruction names.`;
      // The largest u64 is still an allowance each transfer spends down.
      return {
        label: "Approves a delegate",
        value:
          effect.amount === U64_MAX
            ? `Asks to let ${who} move up to ${U64_MAX} base units, the largest allowance a token account can hold, ${from}`
            : `Asks to let ${who} move up to ${tokenAmount(effect.amount, effect.decimals)} ${from}`,
      };
    }
    case "delegate-revoked":
      // Revoke clears the delegate whether or not one is set
      // (solana-program/token 38de8d1, program/src/processor.rs:395 to 420).
      return {
        label: "Removes any delegate",
        // The delegate itself may revoke (Token-2022), so the account is not
        // said to be the wallet's.
        value: `Asks to remove any delegate from token account ${where(effect.account)}. Your wallet signs as the authority the instruction names.`,
      };
    case "authority-changed": {
      const what =
        AUTHORITY[effect.authorityType] ?? `${effect.authorityType} authority`;
      return {
        label: "Changes an authority",
        value:
          effect.newAuthority === null
            ? `Asks to set no ${what} on ${where(effect.account)}.`
            : `Asks to set the ${what} of ${where(effect.account)} to ${shown(effect.newAuthority)}.`,
      };
    }
    case "account-closed":
      return {
        label: "Closes a token account",
        value: `Asks to close ${where(effect.account)} and send its SOL to ${where(effect.destination)}.`,
      };
    case "tokens-minted":
      return {
        label: "Mints tokens",
        value: `Asks to mint ${tokenAmount(effect.amount, effect.decimals)} of mint ${where(effect.mint)} to token account ${where(effect.destination)}. Your wallet signs as the mint authority the instruction names.`,
      };
    case "priority-fee":
      return {
        label: "Pays a priority fee",
        value:
          effect.unitLimit === null
            ? `Asks your wallet to pay a priority fee of up to ${sol(effect.lamports)}: ${effect.microLamportsPerUnit} micro-lamports per compute unit, for the runtime's default number of units, at most 1400000.`
            : `Asks your wallet to pay a priority fee of ${sol(effect.lamports)}: ${effect.microLamportsPerUnit} micro-lamports per compute unit for ${effect.unitLimit} units.`,
      };
    case "tokens-burned":
      return {
        label: "Burns tokens",
        // The program checks the authority only when the account's owner is
        // not the System Program or the incinerator (solana-program/token
        // 38de8d1, program/src/processor.rs:620; token-2022 efe55b4, :1273),
        // which the instruction does not show.
        value: `Asks to burn ${tokenAmount(effect.amount, effect.decimals)} from token account ${where(effect.account)}. Your wallet signs as the authority the instruction names.`,
      };
  }
}

/**
 * The row for an effect whose program refuses it whatever the accounts
 * hold (effect.ts): it says what the instruction asks, which program
 * refuses it and why, and that the transaction would fail.
 */
function refusedRow(
  effect: Effect,
  verdict: Extract<InstructionVerdict, { verdict: "refused" }>,
): CardRow {
  const program = PROGRAM_NAME[verdict.program];
  const label =
    verdict.program === "associated-token"
      ? "Refused by the associated token account program"
      : "Refused by the token program";
  // The two refusals the owner's audits named keep their own sentence.
  if (
    verdict.refusal === "owner-removed" &&
    effect.kind === "authority-changed"
  ) {
    return {
      label,
      value: `Asks to remove the owner of token account ${where(effect.account)}, which ${program} refuses, so the transaction would fail.`,
    };
  }
  if (
    verdict.refusal === "closed-into-itself" &&
    effect.kind === "account-closed"
  ) {
    return {
      label,
      value: `Asks to close token account ${where(effect.account)} and send its SOL to that same account, which ${program} refuses, so the transaction would fail.`,
    };
  }
  return {
    label,
    value: `${effectRow(effect, undefined).value} ${capitalized(program)} refuses ${REFUSAL_WHY[verdict.refusal]}, so the transaction would fail.`,
  };
}

// One sentence per undecoded reason, after "Instruction N calls <program>".
const UNDECODED: Readonly<Record<UndecodedReason, string>> = {
  "unknown-program": ", a program limen does not decode.",
  "instruction-not-decoded": " with an instruction limen does not decode.",
  "unexpected-data":
    " with instruction data of a length limen does not expect.",
  "invalid-data": " with instruction data limen cannot read.",
  "missing-accounts": " with fewer accounts than the instruction needs.",
};

// A multisig the wallet signs for is still an authority that is not the
// wallet (summary.ts, authorizedByUser).
const MULTISIG =
  " Your wallet's signature may still count toward it, for example as one signer of a multisig.";

// The summary keeps each instruction that names the wallet neither as its
// payer nor as its authority as its index and kind only, so the card names
// the kind and shows no text from it.
function otherText(kind: TransactionSummary["others"][number]["kind"]): string {
  switch (kind) {
    case "compute-budget":
      return "A compute budget instruction.";
    case "memo":
      return "A memo. The card does not show its text.";
    case "token-other":
      return "A token program instruction whose details are not shown.";
    case "advance-nonce":
      return "Asks to advance a durable nonce.";
    case "sol-transfer":
      return "A SOL transfer that does not name your wallet as its sender.";
    case "sol-transfer-with-seed":
      return "A SOL transfer from an account derived from another address than your wallet.";
    case "create-account":
      return "An account creation that does not name your wallet as its payer.";
    case "assign":
      return "An owner change for an account other than your wallet account.";
    case "create-token-account":
      return "A token account creation that does not name your wallet as its payer.";
    case "token-transfer":
      return `A token transfer that does not name your wallet as its authority.${MULTISIG}`;
    case "token-approve":
      return `A delegate approval that does not name your wallet as its authority.${MULTISIG}`;
    case "token-revoke":
      return `A delegate removal that does not name your wallet as its authority.${MULTISIG}`;
    case "token-set-authority":
      return `An authority change that does not name your wallet as its authority.${MULTISIG}`;
    case "token-close-account":
      return `A token account close that does not name your wallet as its authority.${MULTISIG}`;
    case "token-burn":
      return `A token burn that does not name your wallet as its authority.${MULTISIG}`;
    case "token-mint-to":
      return `A mint that does not name your wallet as its mint authority.${MULTISIG}`;
  }
}

/** A failed run's error, as far as limen shows it exactly (failure.ts). */
function failureText(err: RunError): string {
  if (err.transactionError === null)
    return "Failed on devnet (detail not shown).";
  if (err.transactionError !== "InstructionError") {
    return `Failed on devnet: ${err.transactionError}.`;
  }
  if (err.instruction === null) {
    return "Failed on devnet: InstructionError (detail not shown).";
  }
  // Instructions are numbered from 1 on the card, as in its other rows.
  const at = `Failed on devnet: InstructionError in instruction ${err.instruction + 1}`;
  if (err.instructionError === null) return `${at} (detail not shown).`;
  if (err.instructionError === "Custom") {
    return err.custom === null
      ? `${at}: Custom (detail not shown).`
      : `${at}: Custom ${err.custom}.`;
  }
  return `${at}: ${err.instructionError}.`;
}

// The one simulated change a card shows (ruling 20a): the wallet's SOL
// before and after, from the simulation's own run.
function changeRow(change: BalanceChange): CardRow {
  return {
    label: "Your wallet, simulated",
    value: `${sol(change.before)} before, ${sol(change.after)} after.`,
  };
}

const BLOCK: Readonly<Record<SignBlock, string>> = {
  "cosigner-missing":
    "it needs another signature that is missing. The Solana Pay format has wallets refuse such a transaction.",
  "simulation-not-run":
    "no simulation result could be used, so this card shows only the decoded instructions. Signing waits for one from devnet.",
  "simulation-failed":
    "the transaction failed when simulated on devnet. Signed now, it would most likely fail the same way.",
};

// The two ways the drain pattern (drain.ts) fires, said the same way on every
// card: in the decoded instructions, or only in the simulation.
const DRAIN = {
  // What the decoded instructions ask the wallet to authorize; they show no
  // ownership, so no account is called the wallet's here.
  decoded:
    "It asks your wallet to give another address control of tokens or accounts.",
  // Clause 2 of the drain pattern (drain.ts): the wallet's SOL sweep.
  simulated:
    "As simulated, your wallet would be left with less than a tenth of the SOL it held.",
} as const;

// What the simulation adds to a card, said only as far as a result is used.
function simulated(simulation: SimulationOutcome): string {
  if (simulation.status === "not-run") {
    return "No simulation result is used, so no balance change is shown.";
  }
  if (simulation.err !== null) {
    return "The simulation failed, so no balance change is shown.";
  }
  // A run that leaves the wallet's SOL as it was lists no change (the audit
  // of 21e1f9f, item 9).
  return simulation.changes.length === 0
    ? "The simulation ran, and your wallet's SOL balance stays the same."
    : "The simulation ran, and any change it found to your wallet's SOL is shown below.";
}

/**
 * The host a transaction request link is sent to, with its port, as the
 * app's URL parser reads it. A user name or password before the host is
 * not shown: "https://pay.example@evil.example" goes to evil.example. Text
 * that is not an https URL is shown as it is.
 */
export function linkHost(link: string): string {
  try {
    const url = new URL(link);
    return url.protocol === "https:" ? url.host : link;
  } catch {
    return link;
  }
}

/** The card for a transaction request, from its link and pre-flight. */
export function transactionCardText(
  link: string,
  message: string | null,
  result: Preflight,
): CardText {
  const from: CardRow = { label: "Requested from", value: linkHost(link) };

  if (result.kind === "not-devnet") {
    // Only another well-formed genesis hash stops here; one limen could not
    // read leaves devnet unconfirmed instead (the audit of 6c4e64e, Major 9).
    return {
      title: "Stopped: not devnet",
      tone: "flagged",
      status:
        "The RPC endpoint's genesis hash is another cluster's, not Solana devnet's, so limen stops here. limen runs on devnet only.",
      rows: [from],
    };
  }
  if (result.kind === "user-not-fee-payer") {
    return {
      title: "Stopped: not your wallet's transaction",
      tone: "flagged",
      status:
        "limen holds this transaction: its fee payer is another wallet, and limen pre-flights only transactions your wallet pays the fee for.",
      rows: [from, { label: "Fee payer", value: result.feePayer }],
    };
  }
  if (result.kind === "user-not-given") {
    // limen was given no wallet address, or one that is not a public key;
    // it cannot tell that no wallet is connected.
    return {
      title: "Stopped: no readable wallet address",
      tone: "flagged",
      status:
        "limen holds this transaction: it was given no wallet address it can read, and limen pre-flights a transaction only for the wallet that pays its fee.",
      rows: [from],
    };
  }
  if (result.kind === "malformed") {
    return {
      // Ruling 20a, item 7: the heading says what limen knows, that it
      // cannot read the bytes, not that they break a format.
      title: "limen cannot read this transaction",
      tone: "malformed",
      // limen reads legacy and version 0 transactions only, so it says what
      // it could not read, never that the transaction breaks Solana's rules.
      status: `limen flags this transaction: limen cannot read it as a legacy or version 0 Solana transaction (${result.problem}).`,
      rows: [from],
    };
  }

  const { summary, verdicts, simulation, blocks } = result;
  const fallback = summary.undecoded.length > 0;
  // The card's flag is the drain pattern, the one definition (drain.ts),
  // which reads each instruction's one verdict (effect.ts).
  const handsOver = verdicts.some(handsOverControl);
  const verdictOf = (instruction: number) =>
    verdicts.find((verdict) => verdict.instruction === instruction);
  const drains = drainPattern(toReport(result));
  const failed = simulation.status === "ran" && simulation.err !== null;
  const lower = (text: string) =>
    `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

  const rows: CardRow[] = [from];
  if (message !== null) {
    rows.push({
      label: "Message, as written by the requester",
      value: asWritten(message),
      quoted: true,
    });
  }
  rows.push(
    ...summary.effects.map((effect) =>
      effectRow(effect, verdictOf(effect.instruction)),
    ),
  );
  for (const entry of summary.undecoded) {
    rows.push({
      label: "Not decoded",
      value: `Instruction ${entry.instruction + 1} calls ${entry.programId}${UNDECODED[entry.reason]}`,
    });
  }
  for (const other of summary.others) {
    const verdict = verdictOf(other.instruction);
    rows.push({
      label: "Also in the transaction",
      value:
        verdict?.verdict === "refused"
          ? `${otherText(other.kind)} It asks for what ${PROGRAM_NAME[verdict.program]} refuses (${REFUSAL_WHY[verdict.refusal]}), so the transaction would fail.`
          : otherText(other.kind),
    });
  }
  if (summary.unresolvedAccounts > 0) {
    rows.push({
      label: "Lookup tables",
      value:
        summary.unresolvedAccounts === 1
          ? "1 address comes from a lookup table. limen shows an address from a lookup table only with a simulation result it uses, so this one is not shown."
          : `${summary.unresolvedAccounts} addresses come from lookup tables. limen shows an address from a lookup table only with a simulation result it uses, so these are not shown.`,
    });
  }

  if (simulation.status === "not-run") {
    rows.push({
      label: "Simulation",
      value: `Not used: ${simulation.reason}. The decoded instructions above still apply.`,
    });
  } else {
    rows.push({
      label: "Simulation",
      value:
        simulation.err === null
          ? "Ran on devnet without an error."
          : `${failureText(simulation.err)} Signed now, the transaction would most likely fail the same way.`,
    });
    // A failed run's changes are not shown, as the status says.
    if (simulation.err === null) {
      rows.push(...simulation.changes.map(changeRow));
    }
  }

  rows.push({
    label: "Fee payer",
    value: result.feePayerSet
      ? "Your wallet. The request left the fee payer unset, so limen set your wallet, as the Solana Pay specification has the wallet do. limen pre-flights only transactions your wallet pays the fee for."
      : "Your wallet. limen pre-flights only transactions your wallet pays the fee for.",
  });
  for (const block of blocks) {
    rows.push({ label: "limen holds this transaction", value: BLOCK[block] });
  }

  return {
    title: fallback
      ? "Fallback: limen cannot decode all of this transaction"
      : "Solana Pay transaction request",
    tone: fallback || drains || blocks.length > 0 ? "flagged" : "neutral",
    status: fallback
      ? `limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. ${simulated(simulation)}${handsOver ? ` ${DRAIN.decoded}` : drains ? ` ${DRAIN.simulated}` : ""}`
      : handsOver
        ? failed
          ? `limen flags this transaction: ${lower(DRAIN.decoded)} The simulation failed, so signed now it would most likely fail.`
          : `limen flags this transaction: ${lower(DRAIN.decoded)}`
        : drains
          ? `limen flags this transaction: ${lower(DRAIN.simulated)}`
          : simulation.status === "ran" && simulation.err === null
            ? // The one simulated change a row shows is the wallet's SOL
              // (changeRow, ruling 20a).
              `${simulation.changes.length === 0 ? "As simulated, your wallet's SOL balance stays the same." : "This card shows the change limen simulated to your wallet's SOL."} Other simulated changes, such as tokens moved or SOL sent to a token account by another signer, are not shown.`
            : `This card shows what the decoded instructions ask for. ${simulated(simulation)}`,
    rows,
  };
}
