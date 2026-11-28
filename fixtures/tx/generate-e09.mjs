// Builds the E-09 fixture transactions with @solana/web3.js 1.99.0 and
// @solana/spl-token 0.4.15, the encoders the decoder is checked against, and
// writes each one with the summary it owes. The owed summaries are written
// here from the inputs used to build each transaction, not from the decoder.
//
// Run from the repository root:  node fixtures/tx/generate-e09.mjs
// Then:                          npx prettier --write fixtures/tx/e09-transactions.json
//
// Every key is the SHA-256 of a fixed label, used as a public key. None was
// made from a keypair, so none was built to sign. Signatures in the "partly
// signed" cases are fixed filler bytes, not real signatures. Each summary is
// written for the transaction's fee payer, as the decoder writes it, with the
// role marker "user" in place of the fee payer's address.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import {
  createApproveInstruction,
  createSetAuthorityInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const key = (label) =>
  new PublicKey(createHash("sha256").update(`limen-e09-${label}`).digest());

const user = key("user");
const attacker = key("attacker");
const organizer = key("organizer");
const cosigner = key("cosigner");
const userTokenAccount = key("user-token-account");
const userToken2022Account = key("user-token-2022-account");
const mint = key("mint");
const unknownProgram = key("unknown-program");
const lookupTable = key("lookup-table");
const blockhash = key("blockhash").toBase58();
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const U64_MAX = 18446744073709551615n;

const memo = (text) =>
  new TransactionInstruction({
    programId: MEMO,
    keys: [],
    data: Buffer.from(text, "ascii"),
  });

function build(
  instructions,
  { payer = user, tables = null, signatures = null } = {},
) {
  const compiled = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  });
  const message = tables
    ? compiled.compileToV0Message(tables)
    : compiled.compileToLegacyMessage();
  const count = message.header.numRequiredSignatures;
  const sigs = Array.from(
    { length: count },
    (_, i) =>
      signatures?.[message.staticAccountKeys[i].toBase58()] ??
      new Uint8Array(64),
  );
  return Buffer.from(
    new VersionedTransaction(message, sigs).serialize(),
  ).toString("base64");
}

const at = (publicKey) => ({ address: publicKey.toBase58() });
const lamports = (sol) => String(Math.round(sol * 1e9));
// The summary writes "user" for the fee payer's wallet, never its address.
const userSigner = (others = [], unsigned = true) => ({
  feePayer: "user",
  others,
  unsigned,
});

// The drainer: drains SOL and approves a delegate over the user's tokens, with
// a priority fee and a friendly memo around it.
const drainerInstructions = () => [
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
  memo("Claim your limen pass"),
  SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: attacker,
    lamports: 4.99e9,
  }),
  createApproveInstruction(
    userTokenAccount,
    attacker,
    user,
    U64_MAX,
    [],
    TOKEN_PROGRAM_ID,
  ),
];
// The priority fee: 50000 micro-lamports per compute unit with no limit set,
// so at most 50000 * 1400000 / 1000000 = 70000 lamports (agave's cap of
// 1400000 units).
const drainerFee = {
  kind: "priority-fee",
  instruction: 0,
  microLamportsPerUnit: "50000",
  unitLimit: null,
  lamports: "70000",
};
const drainerEffects = [
  drainerFee,
  {
    kind: "sol-out",
    instruction: 2,
    to: at(attacker),
    lamports: lamports(4.99),
    reason: "transfer",
  },
  {
    kind: "delegate-approved",
    instruction: 3,
    program: "token",
    account: at(userTokenAccount),
    delegate: at(attacker),
    mint: null,
    amount: U64_MAX.toString(),
    decimals: null,
  },
];
const drainerOthers = [{ instruction: 1, kind: "memo" }];

const table = new AddressLookupTableAccount({
  key: lookupTable,
  state: {
    deactivationSlot: U64_MAX,
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    authority: undefined,
    addresses: [organizer, attacker],
  },
});

const cases = [
  {
    name: "drainer: SOL balance out and a delegate approved over the user's tokens",
    transaction: build(drainerInstructions()),
    tables: {},
    owed: {
      effects: drainerEffects,
      others: drainerOthers,
      undecoded: [],
      signers: userSigner(),
      unresolvedAccounts: 0,
    },
  },
  {
    name: "drainer as a v0 transaction, attacker address in a loaded lookup table",
    transaction: build(drainerInstructions(), { tables: [table] }),
    tables: {
      [lookupTable.toBase58()]: [organizer.toBase58(), attacker.toBase58()],
    },
    owed: {
      effects: drainerEffects,
      others: drainerOthers,
      undecoded: [],
      signers: userSigner(),
      unresolvedAccounts: 0,
    },
  },
  {
    name: "drainer as a v0 transaction, lookup table not loaded",
    transaction: build(drainerInstructions(), { tables: [table] }),
    tables: {},
    owed: {
      effects: [
        drainerFee,
        {
          ...drainerEffects[1],
          to: { table: lookupTable.toBase58(), index: 1 },
        },
        {
          ...drainerEffects[2],
          delegate: { table: lookupTable.toBase58(), index: 1 },
        },
      ],
      others: drainerOthers,
      undecoded: [],
      signers: userSigner(),
      unresolvedAccounts: 1,
    },
  },
  {
    name: "unknown program: fallback, with the decodable transfer still shown",
    transaction: build([
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: organizer,
        lamports: 0.01e9,
      }),
      new TransactionInstruction({
        programId: unknownProgram,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([1, 2, 3, 4]),
      }),
    ]),
    tables: {},
    owed: {
      effects: [
        {
          kind: "sol-out",
          instruction: 0,
          to: at(organizer),
          lamports: lamports(0.01),
          reason: "transfer",
        },
      ],
      others: [],
      undecoded: [
        {
          instruction: 1,
          programId: unknownProgram.toBase58(),
          reason: "unknown-program",
        },
      ],
      signers: userSigner(),
      unresolvedAccounts: 0,
    },
  },
  {
    name: "Token-2022 owner change and close, plus a checked transfer",
    transaction: build([
      createTransferCheckedInstruction(
        userToken2022Account,
        mint,
        organizer,
        user,
        2500000n,
        6,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      createSetAuthorityInstruction(
        userToken2022Account,
        user,
        AuthorityType.AccountOwner,
        attacker,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      createCloseAccountInstruction(
        userTokenAccount,
        attacker,
        user,
        [],
        TOKEN_PROGRAM_ID,
      ),
    ]),
    tables: {},
    owed: {
      // A Token-2022 transfer is not decoded: a transfer fee or a transfer
      // hook on the mint would change what it does (E-09 audit finding 3).
      effects: [
        {
          kind: "authority-changed",
          instruction: 1,
          program: "token-2022",
          account: at(userToken2022Account),
          authorityType: "AccountOwner",
          newAuthority: attacker.toBase58(),
        },
        {
          kind: "account-closed",
          instruction: 2,
          program: "token",
          account: at(userTokenAccount),
          destination: at(attacker),
        },
      ],
      others: [],
      undecoded: [
        {
          instruction: 0,
          programId: TOKEN_2022_PROGRAM_ID.toBase58(),
          reason: "instruction-not-decoded",
        },
      ],
      signers: userSigner(),
      unresolvedAccounts: 0,
    },
  },
  {
    name: "Token-2022 Batch instruction is not decoded",
    transaction: build([
      new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [{ pubkey: user, isSigner: true, isWritable: false }],
        data: Buffer.from([255, 4]),
      }),
    ]),
    tables: {},
    owed: {
      effects: [],
      others: [],
      undecoded: [
        {
          instruction: 0,
          programId: TOKEN_2022_PROGRAM_ID.toBase58(),
          reason: "instruction-not-decoded",
        },
      ],
      signers: userSigner(),
      unresolvedAccounts: 0,
    },
  },
  {
    name: "System transfer with trailing data is not decoded",
    transaction: build([
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([
          SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: attacker,
            lamports: 1e9,
          }).data,
          Buffer.from([0]),
        ]),
      }),
    ]),
    tables: {},
    owed: {
      effects: [],
      others: [],
      undecoded: [
        {
          instruction: 0,
          programId: SystemProgram.programId.toBase58(),
          reason: "unexpected-data",
        },
      ],
      signers: userSigner(),
      unresolvedAccounts: 0,
    },
  },
  {
    name: "a co-signer that has not signed",
    transaction: build(
      [
        new TransactionInstruction({
          programId: MEMO,
          keys: [
            { pubkey: user, isSigner: true, isWritable: false },
            { pubkey: cosigner, isSigner: true, isWritable: false },
          ],
          data: Buffer.from("co-signed", "ascii"),
        }),
      ],
      { signatures: {} },
    ),
    tables: {},
    owed: {
      effects: [],
      others: [{ instruction: 0, kind: "memo" }],
      undecoded: [],
      signers: userSigner(
        [{ address: cosigner.toBase58(), signed: false }],
        true,
      ),
      unresolvedAccounts: 0,
    },
  },
  {
    name: "a sponsored transaction, summarized for its fee payer, the organizer",
    transaction: build(
      [
        new TransactionInstruction({
          programId: MEMO,
          keys: [{ pubkey: user, isSigner: true, isWritable: false }],
          data: Buffer.from("sponsored", "ascii"),
        }),
      ],
      {
        payer: organizer,
        signatures: { [organizer.toBase58()]: new Uint8Array(64).fill(7) },
      },
    ),
    tables: {},
    owed: {
      effects: [],
      others: [{ instruction: 0, kind: "memo" }],
      undecoded: [],
      signers: {
        feePayer: "user",
        others: [{ address: user.toBase58(), signed: false }],
        unsigned: false,
      },
      unresolvedAccounts: 0,
    },
  },
];

// Account order across two lookup tables, each with writable and readonly
// addresses. The owed order and flags are read back from web3.js
// (getAccountKeys, isAccountSigner, isAccountWritable), an implementation
// independent of the decoder's.
const tableA = new AddressLookupTableAccount({
  key: key("table-a"),
  state: { ...table.state, addresses: [key("a0"), key("a1"), key("a2")] },
});
const tableB = new AddressLookupTableAccount({
  key: key("table-b"),
  state: { ...table.state, addresses: [key("b0"), key("b1"), key("b2")] },
});
const orderMessage = new TransactionMessage({
  payerKey: user,
  recentBlockhash: blockhash,
  instructions: [
    new TransactionInstruction({
      programId: unknownProgram,
      keys: [
        { pubkey: key("b1"), isSigner: false, isWritable: false },
        { pubkey: key("a2"), isSigner: false, isWritable: true },
        { pubkey: key("b0"), isSigner: false, isWritable: true },
        { pubkey: key("a0"), isSigner: false, isWritable: false },
        { pubkey: cosigner, isSigner: true, isWritable: false },
        { pubkey: key("static-writable"), isSigner: false, isWritable: true },
        { pubkey: key("static-readonly"), isSigner: false, isWritable: false },
      ],
      data: Buffer.from([]),
    }),
  ],
}).compileToV0Message([tableA, tableB]);
const orderKeys = orderMessage
  .getAccountKeys({ addressLookupTableAccounts: [tableA, tableB] })
  .keySegments()
  .flat();
const accountOrder = {
  name: "account order across two lookup tables",
  transaction: Buffer.from(
    new VersionedTransaction(orderMessage, [
      new Uint8Array(64),
      new Uint8Array(64),
    ]).serialize(),
  ).toString("base64"),
  tables: Object.fromEntries(
    [tableA, tableB].map((t) => [
      t.key.toBase58(),
      t.state.addresses.map((a) => a.toBase58()),
    ]),
  ),
  owed: orderKeys.map((k, i) => ({
    address: k.toBase58(),
    signer: orderMessage.isAccountSigner(i),
    writable: orderMessage.isAccountWritable(i),
  })),
};

const fixture = {
  unit: "E-09",
  about:
    "Transactions built with @solana/web3.js 1.99.0 and @solana/spl-token 0.4.15 by fixtures/tx/generate-e09.mjs, each with the summary it owes, written for the transaction's fee payer; user is the fee payer of every case but the sponsored one. Keys are SHA-256 hashes of fixed labels used as public keys, none made from a keypair. tables lists the lookup tables loaded for the case.",
  user: user.toBase58(),
  keys: Object.fromEntries(
    Object.entries({
      attacker,
      organizer,
      cosigner,
      userTokenAccount,
      userToken2022Account,
      mint,
      unknownProgram,
      lookupTable,
    }).map(([name, publicKey]) => [name, publicKey.toBase58()]),
  ),
  cases,
  accountOrder,
};

writeFileSync(
  new URL("./e09-transactions.json", import.meta.url),
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log(`wrote ${cases.length} cases`);
