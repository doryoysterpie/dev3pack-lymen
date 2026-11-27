// Transaction-request card text (E-09). App strings live here so the copy
// rules (rule 9) can be checked in one place.

import {
  type BalanceChange,
  type Effect,
  type Place,
  type Preflight,
  type SignBlock,
  type TransactionSummary,
  type UndecodedReason,
  USER_MARKER,
} from "@limen/preflight";

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

function where(place: Place): string {
  return "address" in place
    ? shown(place.address)
    : `an address in lookup table ${place.table} (index ${place.index}) that was not loaded`;
}

function tokenAmount(amount: string, decimals: number | null): string {
  if (amount === U64_MAX) return "the largest possible amount";
  return decimals === null
    ? `${amount} base units`
    : withDecimals(amount, decimals);
}

const AUTHORITY: Readonly<Record<string, string>> = {
  AccountOwner: "Ownership",
  CloseAccount: "The close authority",
  MintTokens: "The mint authority",
  FreezeAccount: "The freeze authority",
};

function effectRow(effect: Effect): CardRow {
  switch (effect.kind) {
    case "sol-out":
      return effect.reason === "create-account"
        ? {
            label: "Pays to create an account",
            value: `Your wallet pays ${sol(effect.lamports)} into new account ${where(effect.to)}.`,
          }
        : {
            label: "Sends SOL",
            value:
              effect.reason === "derived-account"
                ? `${sol(effect.lamports)} from an account derived from your wallet to ${where(effect.to)}.`
                : `${sol(effect.lamports)} from your wallet to ${where(effect.to)}.`,
          };
    case "owner-assigned":
      return {
        label: "Hands over your wallet account",
        value: `Assigns your wallet account to program ${effect.newOwner}, which would then control its SOL.`,
      };
    case "pays-for-token-account":
      return {
        label: "Creates a token account",
        value: `Your wallet pays the rent for token account ${where(effect.account)}.`,
      };
    case "token-out":
      return {
        label: "Sends tokens",
        value: `${tokenAmount(effect.amount, effect.decimals)}${effect.mint === null ? "" : ` of mint ${where(effect.mint)}`} from token account ${where(effect.source)} to ${where(effect.destination)}.`,
      };
    case "delegate-approved":
      return {
        label: "Approves a delegate",
        value:
          effect.amount === U64_MAX
            ? `${where(effect.delegate)} may move every token in your token account ${where(effect.account)}, with no limit.`
            : `${where(effect.delegate)} may move up to ${tokenAmount(effect.amount, effect.decimals)} from your token account ${where(effect.account)}.`,
      };
    case "delegate-revoked":
      return {
        label: "Removes a delegate",
        value: `From your token account ${where(effect.account)}.`,
      };
    case "authority-changed": {
      const what = AUTHORITY[effect.authorityType] ?? effect.authorityType;
      return {
        label: "Changes an authority",
        value:
          effect.newAuthority === null
            ? `${what} of ${where(effect.account)} is removed.`
            : `${what} of ${where(effect.account)} moves to ${shown(effect.newAuthority)}.`,
      };
    }
    case "account-closed":
      return {
        label: "Closes a token account",
        value: `Closes ${where(effect.account)} and sends its SOL to ${where(effect.destination)}.`,
      };
    case "tokens-burned":
      return {
        label: "Burns tokens",
        value: `${tokenAmount(effect.amount, effect.decimals)} from your token account ${where(effect.account)}.`,
      };
  }
}

// Effects that hand control of the user's tokens or accounts to someone else.
const HANDS_OVER = new Set<Effect["kind"]>([
  "owner-assigned",
  "delegate-approved",
  "authority-changed",
  "account-closed",
]);

const UNDECODED: Readonly<Record<UndecodedReason, string>> = {
  "unknown-program": "a program limen does not decode",
  "instruction-not-decoded": "an instruction limen does not decode",
  "unexpected-data": "instruction data of a length limen does not expect",
  "missing-accounts": "fewer accounts than the instruction needs",
};

// The summary keeps each instruction the wallet does not authorize as its index
// and kind only, so the card names the kind and shows no text from it.
function otherText(kind: TransactionSummary["others"][number]["kind"]): string {
  switch (kind) {
    case "compute-budget":
      return "A compute budget instruction.";
    case "memo":
      return "A memo. The card does not show its text.";
    case "token-other":
      return "A token program instruction whose details are not shown.";
    case "advance-nonce":
      return "Advances a durable nonce.";
    default:
      return "An instruction your wallet does not authorize.";
  }
}

function changeRow(change: BalanceChange): CardRow {
  if (change.kind === "sol") {
    return {
      label: "Your SOL, simulated",
      value: `${sol(change.before)} before, ${sol(change.after)} after.`,
    };
  }
  const parts = [`${change.before} base units before, ${change.after} after.`];
  if (change.ownerAfter === null) {
    parts.push("The account is closed.");
  } else {
    if (change.ownerAfter !== USER_MARKER) {
      parts.push(`Owner after: ${shown(change.ownerAfter)}.`);
    }
    if (change.delegateAfter !== change.delegateBefore) {
      parts.push(
        change.delegateAfter === null
          ? "The delegate is removed."
          : `Delegate after: ${shown(change.delegateAfter)}, for up to ${tokenAmount(change.delegatedAmountAfter, null)}.`,
      );
    }
  }
  return {
    label: `Your token account ${change.account}, simulated`,
    value: parts.join(" "),
  };
}

const BLOCK: Readonly<Record<SignBlock, string>> = {
  "cosigner-missing":
    "it needs another signature that is missing. The Solana Pay format has wallets refuse such a transaction.",
};

/** The card for a transaction request, from its link and pre-flight. */
export function transactionCardText(
  link: string,
  message: string | null,
  result: Preflight,
): CardText {
  const host = (() => {
    const match = /^https:\/\/([^/?#]+)/.exec(link);
    return match === null ? link : match[1];
  })();
  const from: CardRow = { label: "Requested from", value: host };

  if (result.kind === "not-devnet") {
    return {
      title: "Stopped: not devnet",
      tone: "flagged",
      status:
        "The RPC endpoint is not Solana devnet, so limen stops here. limen runs on devnet only.",
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
  if (result.kind === "malformed") {
    return {
      title: "Malformed transaction",
      tone: "malformed",
      status: `limen flags this transaction: it does not follow the Solana transaction format (${result.problem}).`,
      rows: [from],
    };
  }

  const { summary, simulation, blocks } = result;
  const fallback = summary.undecoded.length > 0;
  const handsOver = summary.effects.some((effect) =>
    HANDS_OVER.has(effect.kind),
  );

  const rows: CardRow[] = [from];
  if (message !== null) {
    rows.push({
      label: "Message, as written by the requester",
      value: asWritten(message),
      quoted: true,
    });
  }
  rows.push(...summary.effects.map(effectRow));
  for (const entry of summary.undecoded) {
    rows.push({
      label: "Not decoded",
      value: `Instruction ${entry.instruction + 1} calls ${entry.programId}, with ${UNDECODED[entry.reason]}.`,
    });
  }
  for (const other of summary.others) {
    rows.push({
      label: "Also in the transaction",
      value: otherText(other.kind),
    });
  }
  if (summary.unresolvedAccounts > 0) {
    rows.push({
      label: "Lookup tables",
      value: `${summary.unresolvedAccounts} addresses come from lookup tables that were not loaded.`,
    });
  }

  if (simulation.status === "not-run") {
    rows.push({
      label: "Simulation",
      value: `Did not run: ${simulation.reason}. The decoded instructions above still apply.`,
    });
  } else {
    rows.push({
      label: "Simulation",
      value:
        simulation.err === null
          ? "Ran on devnet without an error."
          : `Failed on devnet: ${JSON.stringify(simulation.err)}. Signed now, the transaction would most likely fail the same way.`,
    });
    rows.push(...simulation.changes.map(changeRow));
  }

  rows.push({
    label: "Fee payer",
    value:
      "Your wallet. limen pre-flights only transactions your wallet pays the fee for.",
  });
  for (const block of blocks) {
    rows.push({ label: "limen holds this transaction", value: BLOCK[block] });
  }

  return {
    title: fallback
      ? "Fallback: limen cannot decode all of this transaction"
      : "Solana Pay transaction request",
    tone: fallback || handsOver || blocks.length > 0 ? "flagged" : "neutral",
    status: fallback
      ? "limen flags this transaction: it calls programs or instructions limen cannot decode, so this card cannot show everything it would do. The simulation still shows the balance changes it found."
      : handsOver
        ? "limen flags this transaction: it would hand control of your tokens or accounts to another address."
        : "This card shows what the transaction would do before you sign.",
    rows,
  };
}
