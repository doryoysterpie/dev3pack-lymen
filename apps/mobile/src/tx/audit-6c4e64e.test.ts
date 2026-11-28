// The owner's audit of E-09 at 6c4e64e: what the card says for each Major's
// class. Transactions are built with @solana/web3.js and @solana/spl-token
// (the package's dev dependencies) and pre-flighted through the package.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import {
  DEVNET_GENESIS_HASH,
  preflight,
  SYSTEM_PROGRAM,
  type Fetch,
  type RpcEndpoint,
} from "@limen/preflight";

// Test support from the package, not one of its exports.
import {
  edited,
  legacy,
  once,
} from "../../../../packages/preflight/test-support/build.ts";
import {
  clean as cleanWithTable,
  loadedV0,
  OTHER,
} from "../../../../packages/preflight/test-support/audit.ts";
import {
  endpointFor,
  recordedEndpoint,
} from "../../../../packages/preflight/test-support/recorded.ts";

import { transactionCardText } from "./card-text.ts";
import { requestTransaction } from "./request.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly cases: readonly {
    readonly name: string;
    readonly transaction: string;
  }[];
};
const USER = fixture.user;
const { attacker: ATTACKER, mint: MINT } = fixture.keys;
const ACCOUNT = fixture.keys.userTokenAccount;
const drainer = fixture.cases.find((c) => c.name.startsWith("drainer: SOL"));
assert.ok(drainer);
const LINK = "https://pay.example/solana-pay?order=7";
const BLOCKHASH = "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW";
const user = new web3.PublicKey(USER);
const account = new web3.PublicKey(ACCOUNT);
const attacker = new web3.PublicKey(ATTACKER);
const mint = new web3.PublicKey(MINT);
const SPL = spl.TOKEN_PROGRAM_ID;
const T22 = spl.TOKEN_2022_PROGRAM_ID;
const tx = (...instructions: web3.TransactionInstruction[]) =>
  legacy(USER, instructions, BLOCKHASH);

const unreachable: Fetch = async () => {
  throw new Error("offline");
};
const offline = endpointFor(unreachable, "https://devnet.example");
const clean = (): RpcEndpoint =>
  recordedEndpoint({
    accounts: {
      [USER]: {
        lamports: 5_000_000_000,
        owner: SYSTEM_PROGRAM,
        data: ["", "base64"],
      },
    },
    simulation: {
      err: null,
      accounts: {},
      slot: 7,
      replacementBlockhash: BLOCKHASH,
    },
  });
const cardFor = async (endpoint: RpcEndpoint, transaction: string) =>
  transactionCardText(LINK, null, await preflight(endpoint, transaction, USER));
const rowValue = (
  card: Awaited<ReturnType<typeof cardFor>>,
  label: string,
): string => {
  const found = card.rows.filter((row) => row.label === label);
  assert.equal(found.length, 1, `${label}: ${JSON.stringify(card.rows)}`);
  return found[0].value;
};
const HAND_OVER = "give another address control";

describe("the audit of 6c4e64e, Major 5: the card shows a failed run's error only as agave names it", () => {
  const after =
    " Signed now, the transaction would most likely fail the same way.";
  for (const [err, owed] of [
    ['"InsufficientFundsForFee"', "Failed on devnet: InsufficientFundsForFee."],
    [
      '{"InstructionError":[2,{"Custom":4294967295}]}',
      "Failed on devnet: InstructionError in instruction 3: Custom 4294967295.",
    ],
    [
      '{"InstructionError":[2,{"Custom":9007199254740993}]}',
      "Failed on devnet: InstructionError in instruction 3: Custom (detail not shown).",
    ],
    [
      '{"InstructionError":[2,"InvalidAccountData"]}',
      "Failed on devnet: InstructionError in instruction 3: InvalidAccountData.",
    ],
    [
      '{"InstructionError":[2,"YourWalletIsFine"]}',
      "Failed on devnet: InstructionError in instruction 3 (detail not shown).",
    ],
    [`{"${ATTACKER}":1,"${MINT}":2}`, "Failed on devnet (detail not shown)."],
    ['"YourWalletIsFine"', "Failed on devnet (detail not shown)."],
  ] as const) {
    it(`shows ${err} as: ${owed}`, async () => {
      const card = await cardFor(
        edited(clean(), "simulateTransaction", (text) =>
          once(text, '"err":null', `"err":${err}`),
        ),
        drainer.transaction,
      );
      assert.equal(rowValue(card, "Simulation"), `${owed}${after}`);
    });
  }
});

describe("the audit of 6c4e64e, Major 6: a refused or zero-allowance request is not a hand-over on the card", () => {
  it("a close into itself is refused in its row and not a hand-over in the status", async () => {
    const card = await cardFor(
      offline,
      tx(spl.createCloseAccountInstruction(account, account, user, [], SPL)),
    );
    assert.equal(
      rowValue(card, "Refused by the token program"),
      `Asks to close token account ${ACCOUNT} and send its SOL to that same account, which the Token program refuses, so the transaction would fail.`,
    );
    assert.doesNotMatch(card.status, new RegExp(HAND_OVER));
  });

  it("a SOL transfer to the wallet itself says it moves nothing", async () => {
    const card = await cardFor(
      offline,
      tx(
        web3.SystemProgram.transfer({
          fromPubkey: user,
          toPubkey: user,
          lamports: 5,
        }),
      ),
    );
    assert.equal(
      rowValue(card, "Sends SOL to the same account"),
      "Asks to send 0.000000005 SOL from your wallet to your wallet, which moves no SOL if accepted.",
    );
  });

  it("an approval of 0 is not a hand-over", async () => {
    const card = await cardFor(
      offline,
      tx(spl.createApproveInstruction(account, attacker, user, 0, [], SPL)),
    );
    assert.equal(
      rowValue(card, "Approves a delegate"),
      `Asks to let ${ATTACKER} move up to 0 base units from token account ${ACCOUNT}. Your wallet signs as the owner the instruction names.`,
    );
    assert.doesNotMatch(card.status, new RegExp(HAND_OVER));
  });
});

describe("the audit of 6c4e64e, Major 7: the card says when a clean run contradicts an instruction", () => {
  it("holds a close into itself whose run came back clean", async () => {
    const card = await cardFor(
      clean(),
      tx(spl.createCloseAccountInstruction(account, account, user, [], SPL)),
    );
    assert.equal(
      rowValue(card, "Simulation"),
      "Not used: the simulation ran without an error, though instruction 1 asks for what the Token program refuses (closing an account into itself). The decoded instructions above still apply.",
    );
    assert.ok(
      card.rows.some(
        (row) =>
          row.label === "limen holds this transaction" &&
          row.value.startsWith("no simulation result could be used"),
      ),
    );
  });

  it("says another signer's refused instruction is refused", async () => {
    const other = web3.Keypair.generate().publicKey;
    const card = await cardFor(
      offline,
      tx(spl.createCloseAccountInstruction(account, account, other, [], SPL)),
    );
    assert.match(
      rowValue(card, "Also in the transaction"),
      / It asks for what the Token program refuses \(closing an account into itself\), so the transaction would fail\.$/,
    );
  });
});

describe("the audit of 6c4e64e, Major 8: token amounts in base units, with the decimals the instruction states", () => {
  const decimals = "(the instruction expects a mint with 6 decimals)";
  for (const [name, instruction, label, owed] of [
    [
      "a Token-2022 checked approval",
      spl.createApproveCheckedInstruction(
        account,
        mint,
        attacker,
        user,
        2_500_000,
        6,
        [],
        T22,
      ),
      "Approves a delegate",
      `Asks to let ${ATTACKER} move up to 2500000 base units ${decimals} from token account ${ACCOUNT}. Your wallet signs as the owner the instruction names.`,
    ],
    [
      "a Token-2022 checked mint",
      spl.createMintToCheckedInstruction(
        mint,
        account,
        user,
        2_500_000,
        6,
        [],
        T22,
      ),
      "Mints tokens",
      `Asks to mint 2500000 base units ${decimals} of mint ${MINT} to token account ${ACCOUNT}. Your wallet signs as the mint authority the instruction names.`,
    ],
    [
      "a Token-2022 checked burn",
      spl.createBurnCheckedInstruction(
        account,
        mint,
        user,
        2_500_000,
        6,
        [],
        T22,
      ),
      "Burns tokens",
      `Asks to burn 2500000 base units ${decimals} from token account ${ACCOUNT}. Your wallet signs as the authority the instruction names.`,
    ],
    [
      "a checked transfer",
      spl.createTransferCheckedInstruction(
        account,
        mint,
        attacker,
        user,
        2_500_000,
        6,
        [],
        SPL,
      ),
      "Sends tokens",
      `Asks to send 2500000 base units ${decimals} of mint ${MINT} from token account ${ACCOUNT} to ${ATTACKER}.`,
    ],
    [
      "a transfer of the largest u64",
      spl.createTransferInstruction(
        account,
        attacker,
        user,
        BigInt("18446744073709551615"),
        [],
        SPL,
      ),
      "Sends tokens",
      `Asks to send 18446744073709551615 base units from token account ${ACCOUNT} to ${ATTACKER}.`,
    ],
  ] as const) {
    it(`${name}: no derived quantity on any row`, async () => {
      const card = await cardFor(offline, tx(instruction));
      assert.equal(rowValue(card, label), owed);
      assert.equal(JSON.stringify(card).includes("2.5"), false);
    });
  }
});

describe("the audit of 6c4e64e, Major 9: could not check is never a negative fact", () => {
  it("says it could not confirm devnet for a genesis result that is not a hash", async () => {
    const card = await cardFor(
      edited(clean(), "getGenesisHash", (text) =>
        once(text, JSON.stringify(DEVNET_GENESIS_HASH), '""'),
      ),
      drainer.transaction,
    );
    assert.doesNotMatch(card.title, /not devnet/);
    assert.equal(
      rowValue(card, "Simulation"),
      "Not used: limen could not confirm devnet: getGenesisHash: not a 32-byte hash. The decoded instructions above still apply.",
    );
  });

  it("names another cluster only when its genesis hash is one", () => {
    const card = transactionCardText(LINK, null, { kind: "not-devnet" });
    assert.equal(
      card.status,
      "The RPC endpoint's genesis hash is another cluster's, not Solana devnet's, so limen stops here. limen runs on devnet only.",
    );
  });

  it("does not say no wallet is connected when it was given none it can read", () => {
    const card = transactionCardText(LINK, null, { kind: "user-not-given" });
    assert.equal(card.title, "Stopped: no readable wallet address");
    assert.equal(
      card.status,
      "limen holds this transaction: it was given no wallet address it can read, and limen pre-flights a transaction only for the wallet that pays its fee.",
    );
  });

  it("Major 1, swept: refuses a link answer that names a member twice", async () => {
    const answer: Fetch = async (url) => ({
      ok: true,
      status: 200,
      url,
      text: '{"transaction":"AQ==","transaction":"AA=="}',
    });
    await assert.rejects(requestTransaction(answer, LINK, USER), {
      reason: "not-json",
      message: "the link's answer names a member twice",
    });
  });

  it("does not call an answer with no final URL redirected", async () => {
    const answer: Fetch = async () => ({
      ok: true,
      status: 200,
      url: "",
      text: '{"transaction":"AQ=="}',
    });
    await assert.rejects(requestTransaction(answer, LINK, USER), {
      reason: "no-final-url",
      message:
        "the answer gave no final URL, so limen cannot confirm it came from the link and will not show what it answered",
    });
  });
});

describe("the audit of 6c4e64e, Major 2: the card shows no address from a lookup table the run disputes", () => {
  it("names the attacker from the table only when the run is used", async () => {
    const used = await cardFor(cleanWithTable(), loadedV0.transaction);
    assert.ok(JSON.stringify(used).includes(ATTACKER));
    // The run disputes the table and also lists one balance too few.
    const disputed = await cardFor(
      edited(cleanWithTable(), "simulateTransaction", (text) =>
        once(
          once(text, ATTACKER, OTHER),
          '"preBalances":[5000000000,',
          '"preBalances":[',
        ),
      ),
      loadedV0.transaction,
    );
    assert.equal(JSON.stringify(disputed).includes(ATTACKER), false);
    assert.match(
      rowValue(disputed, "Lookup tables"),
      /^1 address comes from a lookup table\. limen shows an address from a lookup table only after a simulation runs without an error, so this one is not shown\.$/,
    );
  });

  it("audit of 1856942, bug 1: leaves lookup-table addresses unresolved on the card after a failed v0 run", async () => {
    const failed = await cardFor(
      edited(cleanWithTable(), "simulateTransaction", (text) =>
        once(text, '"err":null', '"err":"InsufficientFundsForFee"'),
      ),
      loadedV0.transaction,
    );
    assert.equal(JSON.stringify(failed).includes(ATTACKER), false);
    assert.equal(
      rowValue(failed, "Simulation"),
      "Failed on devnet: InsufficientFundsForFee. Signed now, the transaction would most likely fail the same way.",
    );
    assert.equal(
      rowValue(failed, "Lookup tables"),
      "1 address comes from a lookup table. limen shows an address from a lookup table only after a simulation runs without an error, so this one is not shown.",
    );
  });
});

describe("the audit of 1856942", () => {
  it("bug 2: priority-fee row shows an explicit compute-unit limit even with trailing data", async () => {
    const limit = web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 200_000,
    });
    const limitWithTrailing = new web3.TransactionInstruction({
      programId: limit.programId,
      keys: limit.keys,
      data: Buffer.concat([limit.data, Buffer.from([0xff])]),
    });
    const price = web3.ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 50_000,
    });
    const card = await cardFor(offline, tx(limitWithTrailing, price));
    assert.equal(card.title, "Solana Pay transaction request");
    assert.equal(
      rowValue(card, "Pays a priority fee"),
      "Asks your wallet to pay a priority fee of 0.00001 SOL: 50000 micro-lamports per compute unit for 200000 units.",
    );
  });

  it("minor: a maximum checked approval includes its expected decimals", async () => {
    for (const program of [SPL, T22]) {
      const card = await cardFor(
        offline,
        tx(
          spl.createApproveCheckedInstruction(
            account,
            mint,
            attacker,
            user,
            BigInt("18446744073709551615"),
            6,
            [],
            program,
          ),
        ),
      );
      assert.equal(
        rowValue(card, "Approves a delegate"),
        `Asks to let ${ATTACKER} move up to 18446744073709551615 base units (the instruction expects a mint with 6 decimals), the largest allowance a token account can hold, from token account ${ACCOUNT}. Your wallet signs as the owner the instruction names.`,
      );
    }
  });

  it("minor: InitializeAccount, SyncNative, InitializeAccount3 and InitializeImmutableOwner each get their own row", async () => {
    for (const [instruction, owed] of [
      [
        spl.createInitializeAccountInstruction(account, mint, user, SPL),
        "A token InitializeAccount instruction.",
      ],
      [
        spl.createSyncNativeInstruction(account, SPL),
        "A token SyncNative instruction.",
      ],
      [
        spl.createInitializeAccount3Instruction(account, mint, user, T22),
        "A token InitializeAccount3 instruction.",
      ],
      [
        spl.createInitializeImmutableOwnerInstruction(account, T22),
        "A token InitializeImmutableOwner instruction.",
      ],
    ] as const) {
      const card = await cardFor(offline, tx(instruction));
      assert.equal(rowValue(card, "Also in the transaction"), owed);
    }
  });
});
