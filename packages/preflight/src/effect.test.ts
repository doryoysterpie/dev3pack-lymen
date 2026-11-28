// The owner's audit of E-09 at 6c4e64e, Majors 6 and 7: one function decides
// each decoded instruction's effect (effect.ts), and the drain pattern and the
// signing gate read it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { preflight } from "./preflight.ts";
import {
  SPL,
  T22,
  USER,
  account,
  attacker,
  clean,
  drainsOffline,
  mint,
  notRun,
  offline,
  ready,
  tx,
  user,
} from "../test-support/audit.ts";

describe("the audit of 6c4e64e, Major 6: a refused or no-effect instruction is never a hand-over", () => {
  for (const [name, instruction] of [
    [
      "an approval of 0",
      spl.createApproveInstruction(account, attacker, user, 0, [], SPL),
    ],
    [
      "a checked approval of 0",
      spl.createApproveCheckedInstruction(
        account,
        mint,
        attacker,
        user,
        0,
        6,
        [],
        SPL,
      ),
    ],
    [
      "a Token-2022 approval of 0",
      spl.createApproveInstruction(account, attacker, user, 0, [], T22),
    ],
    [
      "a close into itself",
      spl.createCloseAccountInstruction(account, account, user, [], SPL),
    ],
    [
      "an owner removal",
      spl.createSetAuthorityInstruction(
        account,
        user,
        spl.AuthorityType.AccountOwner,
        null,
        [],
        SPL,
      ),
    ],
    [
      "a Token-2022 owner removal",
      spl.createSetAuthorityInstruction(
        account,
        user,
        spl.AuthorityType.AccountOwner,
        null,
        [],
        T22,
      ),
    ],
  ] as const) {
    it(`shows no drain pattern for ${name}`, async () => {
      assert.equal(await drainsOffline(tx(instruction)), false);
    });
  }

  for (const [name, instruction] of [
    [
      "an approval of 1",
      spl.createApproveInstruction(account, attacker, user, 1, [], SPL),
    ],
    [
      "a close to another address",
      spl.createCloseAccountInstruction(account, attacker, user, [], SPL),
    ],
    [
      "an owner moved to another address",
      spl.createSetAuthorityInstruction(
        account,
        user,
        spl.AuthorityType.AccountOwner,
        attacker,
        [],
        SPL,
      ),
    ],
    // The class's other side: the wallet's own account created anew for
    // another program is the wallet account assigned to that program.
    [
      "the wallet's own account created for another program",
      web3.SystemProgram.createAccount({
        fromPubkey: user,
        newAccountPubkey: user,
        lamports: 0,
        space: 0,
        programId: attacker,
      }),
    ],
  ] as const) {
    it(`still shows one for ${name}`, async () => {
      assert.equal(await drainsOffline(tx(instruction)), true);
    });
  }
});

describe("the audit of 6c4e64e, Major 7: a clean run contradicted by an instruction is not used", () => {
  const other = web3.Keypair.generate().publicKey;
  for (const [name, transaction] of [
    [
      "a close into itself",
      tx(spl.createCloseAccountInstruction(account, account, user, [], SPL)),
    ],
    [
      "an owner removal",
      tx(
        spl.createSetAuthorityInstruction(
          account,
          user,
          spl.AuthorityType.AccountOwner,
          null,
          [],
          SPL,
        ),
      ),
    ],
    [
      "a Token-2022 owner removal",
      tx(
        spl.createSetAuthorityInstruction(
          account,
          user,
          spl.AuthorityType.AccountOwner,
          null,
          [],
          T22,
        ),
      ),
    ],
    [
      "a checked transfer naming its source as its mint",
      tx(
        spl.createTransferCheckedInstruction(
          account,
          account,
          attacker,
          user,
          1,
          6,
          [],
          SPL,
        ),
      ),
    ],
    [
      "a checked transfer naming its destination as its mint",
      tx(
        spl.createTransferCheckedInstruction(
          account,
          attacker,
          attacker,
          user,
          1,
          6,
          [],
          SPL,
        ),
      ),
    ],
    [
      "a checked approval naming its account as its mint",
      tx(
        spl.createApproveCheckedInstruction(
          account,
          account,
          attacker,
          user,
          1,
          6,
          [],
          SPL,
        ),
      ),
    ],
    [
      "a Token-2022 mint to the mint itself",
      tx(spl.createMintToCheckedInstruction(mint, mint, user, 1, 6, [], T22)),
    ],
    [
      "a burn naming its account as its mint",
      tx(spl.createBurnInstruction(account, account, user, 1, [], SPL)),
    ],
    [
      "a transfer from the wallet's own account as a token account",
      tx(spl.createTransferInstruction(user, attacker, user, 1, [], SPL)),
    ],
    [
      "a Token-2022 revoke on the wallet's own account",
      tx(spl.createRevokeInstruction(user, user, [], T22)),
    ],
    [
      "another signer's close into itself",
      tx(spl.createCloseAccountInstruction(account, account, other, [], SPL)),
    ],
  ] as const) {
    it(`holds signing for ${name}`, async () => {
      const reason = await notRun(clean(), transaction);
      assert.match(
        reason,
        /^the simulation ran without an error, though instruction 1 asks for what (the Token program|Token-2022) refuses/,
      );
    });
  }

  it("uses a clean run when no instruction is refused", async () => {
    for (const transaction of [
      tx(spl.createCloseAccountInstruction(account, attacker, user, [], SPL)),
      tx(spl.createApproveInstruction(account, attacker, user, 0, [], SPL)),
      tx(spl.createTransferInstruction(account, account, user, 5, [], SPL)),
    ]) {
      const result = ready(await preflight(clean(), transaction, USER));
      assert.equal(result.simulation.status, "ran");
      assert.deepEqual(result.blocks, []);
    }
  });
});

describe("the audit of 6c4e64e, Major 7, swept: every instruction kind the decoder names", () => {
  const verdictsOf = async (transaction: string) => {
    const result = ready(await preflight(offline, transaction, USER));
    return result.verdicts.map((verdict) =>
      verdict.verdict === "refused"
        ? `${verdict.verdict} ${verdict.program} ${verdict.refusal}`
        : verdict.verdict,
    );
  };
  const ata = (account: web3.PublicKey, program = SPL) =>
    spl.createAssociatedTokenAccountInstruction(
      user,
      account,
      user,
      mint,
      program,
    );

  it("an associated token account creation at another address than the derived one is refused", async () => {
    const derived = spl.getAssociatedTokenAddressSync(mint, user, false, T22);
    assert.deepEqual(await verdictsOf(tx(ata(derived, T22))), ["other"]);
    assert.deepEqual(await verdictsOf(tx(ata(attacker, T22))), [
      "refused associated-token not-derived-address",
    ]);
    // Derived for the other token program is not this one's address.
    assert.deepEqual(await verdictsOf(tx(ata(derived, SPL))), [
      "refused associated-token not-derived-address",
    ]);
  });

  it("the named token instructions on the wallet's own account are refused", async () => {
    for (const instruction of [
      spl.createSyncNativeInstruction(user, SPL),
      spl.createInitializeAccount3Instruction(user, mint, attacker, T22),
      spl.createInitializeImmutableOwnerInstruction(user, T22),
    ]) {
      assert.deepEqual(await verdictsOf(tx(instruction)), [
        `refused ${instruction.programId.equals(SPL) ? "token" : "token-2022"} wallet-as-token-state`,
      ]);
    }
    assert.deepEqual(
      await verdictsOf(tx(spl.createSyncNativeInstruction(account, SPL))),
      ["other"],
    );
  });

  it("an authority change on the wallet's own account is refused", async () => {
    assert.deepEqual(
      await verdictsOf(
        tx(
          spl.createSetAuthorityInstruction(
            user,
            user,
            spl.AuthorityType.CloseAccount,
            attacker,
            [],
            T22,
          ),
        ),
      ),
      ["refused token-2022 wallet-as-token-state"],
    );
  });

  it("after an instruction limen does not decode, the wallet is no longer known to be a System account", async () => {
    const unknown = new web3.TransactionInstruction({
      programId: web3.PublicKey.unique(),
      keys: [{ pubkey: user, isSigner: true, isWritable: true }],
      data: Buffer.from([1]),
    });
    const transfer = spl.createTransferInstruction(user, attacker, user, 1);
    assert.deepEqual(await verdictsOf(tx(transfer, unknown)), [
      "refused token wallet-as-token-state",
      "not-decoded",
    ]);
    assert.deepEqual(await verdictsOf(tx(unknown, transfer)), [
      "not-decoded",
      "other",
    ]);
  });

  it("a SOL transfer to the account it comes from moves nothing", async () => {
    assert.deepEqual(
      await verdictsOf(
        tx(
          web3.SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: user,
            lamports: 5,
          }),
        ),
      ),
      ["no-effect"],
    );
  });
});

describe("the audit of 6c4e64e, Major 7, swept: compute budget instructions the runtime refuses", () => {
  const budget = (...data: number[][]) =>
    tx(
      ...data.map(
        (bytes) =>
          new web3.TransactionInstruction({
            programId: web3.ComputeBudgetProgram.programId,
            keys: [],
            data: Buffer.from(bytes),
          }),
      ),
    );
  const u32 = (value: number) => [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    value >>> 24,
  ];
  const verdictsOf = async (transaction: string) =>
    ready(await preflight(offline, transaction, USER)).verdicts.map(
      (verdict) =>
        verdict.verdict === "refused"
          ? `${verdict.program} ${verdict.refusal}`
          : verdict.verdict,
    );

  it("holds a second instruction of one kind, data it cannot read, a bad heap frame and a zero data limit", async () => {
    for (const [data, owed] of [
      [
        [
          [2, ...u32(1000)],
          [2, ...u32(2000)],
        ],
        ["other", "runtime compute-budget-duplicate"],
      ],
      [
        [
          [3, 1, 0, 0, 0, 0, 0, 0, 0],
          [3, 2, 0, 0, 0, 0, 0, 0, 0],
        ],
        ["other", "runtime compute-budget-duplicate"],
      ],
      [[[0]], ["runtime compute-budget-data"]],
      [[[9, 0, 0, 0, 0]], ["runtime compute-budget-data"]],
      [[[2, 1, 0]], ["runtime compute-budget-data"]],
      [[[1, ...u32(32 * 1024 - 1024)]], ["runtime heap-frame-size"]],
      [[[1, ...u32(256 * 1024 + 1024)]], ["runtime heap-frame-size"]],
      [[[1, ...u32(33 * 1024 + 1)]], ["runtime heap-frame-size"]],
      [[[4, ...u32(0)]], ["runtime data-size-limit-zero"]],
    ] as const) {
      assert.deepEqual(
        await verdictsOf(budget(...data.map((bytes) => [...bytes]))),
        owed,
        JSON.stringify(data),
      );
    }
  });

  it("uses a clean run whose compute budget instructions the runtime reads", async () => {
    const transaction = budget(
      [1, ...u32(256 * 1024)],
      [2, ...u32(200_000)],
      [3, 1, 0, 0, 0, 0, 0, 0, 0],
      [4, ...u32(64 * 1024)],
    );
    assert.deepEqual(await verdictsOf(transaction), [
      "other",
      "other",
      "other",
      "other",
    ]);
    const result = ready(await preflight(clean(), transaction, USER));
    assert.equal(result.simulation.status, "ran");
    assert.equal(
      await notRun(clean(), budget([2, ...u32(1)], [2, ...u32(1)])),
      "the simulation ran without an error, though instruction 2 asks for what the runtime refuses (a second compute budget instruction of one kind)",
    );
  });
});

describe("the audit of ac1ce67, Major 1: an unresolved lookup-table destination gets its own verdict", () => {
  const tableKey = web3.PublicKey.unique();
  const table = new web3.AddressLookupTableAccount({
    key: tableKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [mint, attacker],
    },
  });
  const v0 = (...instructions: web3.TransactionInstruction[]) => {
    const message = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: mint.toBase58(),
      instructions,
    }).compileToV0Message([table]);
    return Buffer.from(
      new web3.VersionedTransaction(message).serialize(),
    ).toString("base64");
  };

  it("gives unresolved-hand-over to a non-zero approval or close whose target is in an unread lookup table", async () => {
    for (const instruction of [
      spl.createApproveInstruction(account, attacker, user, 1, [], SPL),
      spl.createApproveCheckedInstruction(
        account,
        mint,
        attacker,
        user,
        1,
        6,
        [],
        T22,
      ),
      spl.createCloseAccountInstruction(account, attacker, user, [], SPL),
    ]) {
      const result = ready(await preflight(offline, v0(instruction), USER));
      assert.deepEqual(result.verdicts, [
        {
          instruction: 0,
          verdict: "unresolved-hand-over",
          table: tableKey.toBase58(),
          index: 1,
        },
      ]);
      assert.equal(await drainsOffline(v0(instruction)), false);
      assert.deepEqual(result.blocks, ["simulation-not-run"]);
    }
  });

  it("keeps an approval of 0 or an unauthorized close as other even when the target is in an unread lookup table", async () => {
    const otherSigner = web3.Keypair.generate().publicKey;
    const zeroApprove = ready(
      await preflight(
        offline,
        v0(spl.createApproveInstruction(account, attacker, user, 0, [], SPL)),
        USER,
      ),
    );
    assert.deepEqual(zeroApprove.verdicts, [
      { instruction: 0, verdict: "other" },
    ]);
    const otherCloseMessage = new web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: mint.toBase58(),
      instructions: [
        spl.createCloseAccountInstruction(account, attacker, otherSigner),
      ],
    }).compileToV0Message([table]);
    const otherClose = ready(
      await preflight(
        offline,
        Buffer.from(
          new web3.VersionedTransaction(otherCloseMessage, [
            new Uint8Array(64),
            new Uint8Array(64).fill(1),
          ]).serialize(),
        ).toString("base64"),
        USER,
      ),
    );
    assert.deepEqual(otherClose.verdicts, [
      { instruction: 0, verdict: "other" },
    ]);
  });
});
