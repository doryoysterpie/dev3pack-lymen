import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodePublicKey } from "./base58.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import {
  forSigning,
  preflight,
  signingAllowed,
  type Preflight,
} from "./preflight.ts";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import {
  recordedEndpoint,
  type RecordedAccount,
  type Recording,
} from "../test-support/recorded.ts";
import type { RpcEndpoint } from "./rpc.ts";
import { parseTransaction } from "./wire.ts";

interface FixtureCase {
  readonly name: string;
  readonly transaction: string;
  readonly tables: Readonly<Record<string, readonly string[]>>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly cases: readonly FixtureCase[];
};

const USER = fixture.user;
// The sponsored fixture's fee payer, the organizer's devnet fixture key.
const SPONSOR = "E3RFTY1NdeAf1fD4HH8v6SJWCxTH3bkvBKMbapev8HGW";
const {
  attacker: ATTACKER,
  userTokenAccount: USER_TOKEN_ACCOUNT,
  mint: MINT,
} = fixture.keys;
const caseNamed = (start: string): FixtureCase => {
  const found = fixture.cases.find((c) => c.name.startsWith(start));
  assert.ok(found, start);
  return found;
};
const drainer = caseNamed("drainer: SOL balance out");
const sponsored = caseNamed("a sponsored transaction");
const drainerV0 = caseNamed(
  "drainer as a v0 transaction, lookup table not loaded",
);
const tableKey = fixture.keys.lookupTable;
const tableAddresses = caseNamed(
  "drainer as a v0 transaction, attacker address in a loaded",
).tables[tableKey];
const U64_MAX = "18446744073709551615";

function key(address: string): Uint8Array {
  const bytes = decodePublicKey(address);
  assert.ok(bytes !== null, address);
  return bytes;
}

function u64(value: string): Uint8Array {
  const out = new Uint8Array(8);
  let rest = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest % BigInt(256));
    rest /= BigInt(256);
  }
  return out;
}

/** A 165-byte token account, laid out as interface/src/state.rs packs it. */
function tokenAccount(
  owner: string,
  amount: string,
  delegate: string | null,
  delegated: string,
): string {
  const data = new Uint8Array(165);
  data.set(key(MINT), 0);
  data.set(key(owner), 32);
  data.set(u64(amount), 64);
  if (delegate !== null) {
    data[72] = 1;
    data.set(key(delegate), 76);
  }
  data[108] = 1; // initialized
  data.set(u64(delegated), 121);
  return encodeBase64(data);
}

function lookupTableData(addresses: readonly string[]): string {
  const data = new Uint8Array(56 + 32 * addresses.length);
  data[0] = 1;
  addresses.forEach((address, i) => data.set(key(address), 56 + 32 * i));
  return encodeBase64(data);
}

const account = (
  lamports: number,
  owner: string,
  data: string,
): RecordedAccount => ({
  lamports,
  owner,
  data: [data, "base64"],
  executable: false,
  rentEpoch: 0,
});

// What a devnet RPC would answer for the drainer: the state before, and the
// simulation's state after.
const drainerRecording: Recording = {
  accounts: {
    [USER]: account(5_000_000_000, SYSTEM_PROGRAM, ""),
    [USER_TOKEN_ACCOUNT]: account(
      2_039_280,
      TOKEN_PROGRAM,
      tokenAccount(USER, "1000", null, "0"),
    ),
    [tableKey]: account(
      1,
      ADDRESS_LOOKUP_TABLE_PROGRAM,
      lookupTableData(tableAddresses),
    ),
  },
  simulation: {
    err: null,
    logs: ["Program log: fake"],
    unitsConsumed: 1234,
    slot: 527004383,
    replacementBlockhash: "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW",
    accounts: {
      [USER]: account(9_995_000, SYSTEM_PROGRAM, ""),
      [USER_TOKEN_ACCOUNT]: account(
        2_039_280,
        TOKEN_PROGRAM,
        tokenAccount(USER, "1000", ATTACKER, U64_MAX),
      ),
      [ATTACKER]: account(4_990_000_000, SYSTEM_PROGRAM, ""),
    },
  },
};

/**
 * Lists the JSON-RPC methods an endpoint is asked, and can stand for an
 * unreachable endpoint.
 */
function observed(
  base: RpcEndpoint,
  down = false,
): { readonly endpoint: RpcEndpoint; readonly methods: string[] } {
  const methods: string[] = [];
  return {
    methods,
    endpoint: {
      url: base.url,
      fetch: async (url, init) => {
        methods.push((JSON.parse(init.body) as { method: string }).method);
        if (down) throw new Error("network down");
        return base.fetch(url, init);
      },
    },
  };
}

const drainerRpc = () => recordedEndpoint(drainerRecording);

const ready = (result: Preflight) => {
  assert.equal(result.kind, "ready");
  return result as Extract<Preflight, { kind: "ready" }>;
};

describe("E-09 done test: the drainer pre-flight", () => {
  it("simulates the drainer and shows SOL balance out and the delegate approved", async () => {
    const rpc = drainerRpc();
    const result = ready(await preflight(rpc, drainer.transaction, USER));
    assert.deepEqual(
      result.summary.effects.map((effect) => effect.kind),
      ["priority-fee", "sol-out", "delegate-approved"],
    );
    assert.deepEqual(result.simulatedAt, {
      slot: 527004383,
      blockhash: "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW",
    });
    assert.deepEqual(result.simulation, {
      status: "ran",
      err: null,
      changes: [
        // Ruling 20a: only the wallet's SOL, from the run's own balances.
        // The token account's simulated delegate is no longer listed; the
        // delegate approved is the decoded effect above.
        {
          kind: "sol",
          account: "user",
          before: "5000000000",
          after: "9995000",
        },
      ],
    });
    assert.deepEqual(result.blocks, []);
  });

  it("ruling 20a: asks for no account but the lookup tables, and takes the wallet's SOL from the run", async () => {
    const legacy = observed(drainerRpc());
    ready(await preflight(legacy.endpoint, drainer.transaction, USER));
    assert.deepEqual(legacy.methods, ["getGenesisHash", "simulateTransaction"]);
    // The v0 drainer reads its lookup table, which decoding needs, and
    // nothing else.
    const v0 = observed(drainerRpc());
    const result = ready(
      await preflight(v0.endpoint, drainerV0.transaction, USER),
    );
    assert.deepEqual(v0.methods, [
      "getGenesisHash",
      "getMultipleAccounts",
      "simulateTransaction",
    ]);
    assert.ok(result.simulation.status === "ran");
    assert.deepEqual(result.simulation.changes, [
      { kind: "sol", account: "user", before: "5000000000", after: "9995000" },
    ]);
  });

  it("loads lookup tables through the RPC, so the v0 drainer names the attacker", async () => {
    const rpc = drainerRpc();
    const result = ready(await preflight(rpc, drainerV0.transaction, USER));
    assert.equal(result.summary.unresolvedAccounts, 0);
    const out = result.summary.effects[1];
    assert.ok(out.kind === "sol-out");
    assert.deepEqual(out.to, { address: ATTACKER });
  });
});

describe("pre-flight paths", () => {
  it("stops at an endpoint that is not devnet", async () => {
    const { endpoint: rpc, methods } = observed(
      recordedEndpoint({ ...drainerRecording, genesisHash: MINT }),
    );
    assert.deepEqual(await preflight(rpc, drainer.transaction, USER), {
      kind: "not-devnet",
    });
    assert.deepEqual(methods, ["getGenesisHash"]);
  });

  it("still decodes when the RPC cannot be reached, and says the simulation did not run", async () => {
    const { endpoint: rpc } = observed(drainerRpc(), true);
    const result = ready(await preflight(rpc, drainer.transaction, USER));
    assert.equal(result.simulation.status, "not-run");
    assert.deepEqual(
      result.summary.effects.map((effect) => effect.kind),
      ["priority-fee", "sol-out", "delegate-approved"],
    );
  });

  it("reports a simulation error for an unknown program as agave names it, without a crash", async () => {
    const err = { InstructionError: [1, "InvalidInstructionData"] };
    const rpc = recordedEndpoint({
      ...drainerRecording,
      simulation: { ...drainerRecording.simulation, err },
    });
    const result = ready(
      await preflight(rpc, caseNamed("unknown program").transaction, USER),
    );
    assert.deepEqual(
      result.summary.undecoded.map((u) => u.reason),
      ["unknown-program"],
    );
    assert.ok(result.simulation.status === "ran");
    // Only agave's variant names and the index (failure.ts; the audit of
    // 6c4e64e, Major 5).
    assert.deepEqual(result.simulation.err, {
      transactionError: "InstructionError",
      instruction: 1,
      instructionError: "InvalidInstructionData",
      custom: null,
    });
  });

  it("blocks signing when a co-signer has not signed", async () => {
    const rpc = drainerRpc();
    const result = ready(
      await preflight(
        rpc,
        caseNamed("a co-signer that has not signed").transaction,
        USER,
      ),
    );
    assert.deepEqual(result.blocks, ["cosigner-missing"]);
  });

  it("refuses a wallet that is not the fee payer", async () => {
    const rpc = drainerRpc();
    const other = "GsJrhpq3YeSBYmKAtkbQFjYN9EoLJvVJvfvs9pTQ84Hc";
    assert.deepEqual(await preflight(rpc, drainer.transaction, other), {
      kind: "user-not-fee-payer",
      feePayer: USER,
    });
    // The sponsored transaction's fee payer is the organizer, not the user.
    assert.deepEqual(await preflight(rpc, sponsored.transaction, USER), {
      kind: "user-not-fee-payer",
      feePayer: "E3RFTY1NdeAf1fD4HH8v6SJWCxTH3bkvBKMbapev8HGW",
    });
  });

  it("summarizes a sponsored transaction for its fee payer, and blocks the missing signature", async () => {
    const rpc = drainerRpc();
    const result = ready(await preflight(rpc, sponsored.transaction, SPONSOR));
    // The organizer pays the fee, so the organizer is the wallet summarized
    // for, named by its role.
    assert.equal(result.summary.signers.feePayer, "user");
    assert.deepEqual(result.blocks, ["cosigner-missing"]);
  });

  it("refuses text that is not base64 and a truncated transaction", async () => {
    const rpc = drainerRpc();
    assert.deepEqual(await preflight(rpc, "not base64!", USER), {
      kind: "malformed",
      problem: "not-base64",
    });
    const bytes = decodeBase64(drainer.transaction);
    assert.ok(bytes !== null);
    const cut = encodeBase64(bytes.slice(0, 200));
    assert.deepEqual(await preflight(rpc, cut, USER), {
      kind: "malformed",
      problem: "truncated",
    });
  });
});

describe("signing gate", () => {
  it("allows signing only after this transaction's card is shown", async () => {
    const rpc = drainerRpc();
    const result = await preflight(rpc, drainer.transaction, USER);
    assert.equal(signingAllowed(result, null), false);
    assert.equal(
      signingAllowed(result, caseNamed("unknown program").transaction),
      false,
    );
    assert.equal(signingAllowed(result, drainer.transaction), true);
  });

  it("never allows signing a blocked transaction, shown or not", async () => {
    const rpc = drainerRpc();
    const c = caseNamed("a co-signer that has not signed");
    const result = await preflight(rpc, c.transaction, USER);
    assert.equal(signingAllowed(result, c.transaction), false);
  });

  it("replaces only the blockhash of an unsigned transaction", async () => {
    const rpc = drainerRpc();
    const result = ready(await preflight(rpc, drainer.transaction, USER));
    const fresh = "GsJrhpq3YeSBYmKAtkbQFjYN9EoLJvVJvfvs9pTQ84Hc";
    const signed = decodeBase64(forSigning(result, fresh));
    assert.ok(signed !== null);
    const reparsed = parseTransaction(signed);
    assert.ok(reparsed.ok);
    assert.equal(reparsed.transaction.message.recentBlockhash, fresh);
    assert.deepEqual(
      { ...reparsed.transaction.message, recentBlockhash: "" },
      { ...result.transaction.message, recentBlockhash: "" },
    );
  });

  it("leaves a signed transaction as it is", async () => {
    const rpc = drainerRpc();
    const result = ready(await preflight(rpc, sponsored.transaction, SPONSOR));
    assert.equal(
      forSigning(result, "GsJrhpq3YeSBYmKAtkbQFjYN9EoLJvVJvfvs9pTQ84Hc"),
      sponsored.transaction,
    );
  });
});

describe("ruling 20a, item 6: the run's keys are the message's", () => {
  // The recorded answer, with its simulateTransaction value changed.
  const changed = (change: (value: Record<string, unknown>) => void) => {
    const base = drainerRpc();
    return {
      url: base.url,
      fetch: (async (url, init) => {
        const answer = await base.fetch(url, init);
        if (!init.body.includes('"simulateTransaction"')) return answer;
        const body = JSON.parse(answer.text) as {
          result: { value: Record<string, unknown> };
        };
        change(body.result.value);
        return { ...answer, text: JSON.stringify(body) };
      }) satisfies RpcEndpoint["fetch"],
    };
  };
  const LOADED =
    "the simulation's loaded addresses do not match the lookup tables read";
  const notUsed = async (
    endpoint: RpcEndpoint,
    transaction: string,
    reason: string,
  ) => {
    const result = ready(await preflight(endpoint, transaction, USER));
    assert.deepEqual(result.simulation, { status: "not-run", reason });
    assert.deepEqual(result.blocks, ["simulation-not-run"]);
  };

  it("uses a v0 run whose loaded addresses are the table read", async () => {
    const result = ready(
      await preflight(drainerRpc(), drainerV0.transaction, USER),
    );
    assert.equal(result.simulation.status, "ran");
  });

  it("leaves a run unused when its loaded addresses differ from the table read", async () => {
    for (const change of [
      (value: Record<string, unknown>) => {
        value.loadedAddresses = { writable: [], readonly: [] };
      },
      (value: Record<string, unknown>) => {
        const loaded = value.loadedAddresses as {
          writable: string[];
          readonly: string[];
        };
        value.loadedAddresses = {
          writable: loaded.readonly,
          readonly: loaded.writable,
        };
      },
      (value: Record<string, unknown>) => {
        value.loadedAddresses = {
          writable: [USER_TOKEN_ACCOUNT],
          readonly: [],
        };
      },
      (value: Record<string, unknown>) => {
        delete value.loadedAddresses;
      },
    ]) {
      await notUsed(changed(change), drainerV0.transaction, LOADED);
    }
  });

  it("the audit of 21e1f9f, item 4: a disputed table feeds neither the decode nor the bundle", async () => {
    const result = ready(
      await preflight(
        changed((value) => {
          value.loadedAddresses = { writable: [], readonly: [] };
        }),
        drainerV0.transaction,
        USER,
      ),
    );
    assert.equal(result.simulation.status, "not-run");
    // Every lookup entry is unresolved, as for a table limen could not read.
    assert.ok(result.summary.unresolvedAccounts > 0);
    const out = result.summary.effects[1];
    assert.ok(out.kind === "sol-out");
    assert.equal("address" in out.to, false);
    assert.equal(result.recipients.includes(ATTACKER), false);
    assert.equal(result.accountKeys.includes(ATTACKER), false);
  });

  it("the audit of 21e1f9f, item 5: token balance entries must be well formed and name a message key", async () => {
    const entry = (fields: Record<string, unknown>) => ({
      accountIndex: 1,
      mint: MINT,
      owner: USER,
      programId: TOKEN_PROGRAM,
      uiTokenAmount: {
        amount: "1",
        decimals: 0,
        uiAmount: 1,
        uiAmountString: "1",
      },
      ...fields,
    });
    for (const [list, fields, reason] of [
      [
        "preTokenBalances",
        { accountIndex: 99 },
        "the simulation's token balances name an account outside the message",
      ],
      [
        "postTokenBalances",
        { accountIndex: 99 },
        "the simulation's token balances name an account outside the message",
      ],
      [
        "preTokenBalances",
        { accountIndex: 1.5 },
        "simulateTransaction: preTokenBalances: entry",
      ],
      [
        "postTokenBalances",
        { mint: "not a key" },
        "simulateTransaction: postTokenBalances: entry",
      ],
      [
        "preTokenBalances",
        { owner: 7 },
        "simulateTransaction: preTokenBalances: entry",
      ],
      [
        "postTokenBalances",
        { uiTokenAmount: { amount: "-1" } },
        "simulateTransaction: postTokenBalances: entry",
      ],
    ] as const) {
      await notUsed(
        changed((value) => {
          value[list] = [entry(fields)];
        }),
        drainer.transaction,
        reason,
      );
    }
    // A well-formed entry is checked, not used.
    const result = ready(
      await preflight(
        changed((value) => {
          value.preTokenBalances = [entry({})];
          value.postTokenBalances = [entry({ owner: undefined })];
        }),
        drainer.transaction,
        USER,
      ),
    );
    assert.equal(result.simulation.status, "ran");
  });

  it("leaves a legacy run unused when it names loaded addresses, or none at all", async () => {
    await notUsed(
      changed((value) => {
        value.loadedAddresses = { writable: [ATTACKER], readonly: [] };
      }),
      drainer.transaction,
      LOADED,
    );
    await notUsed(
      changed((value) => {
        value.loadedAddresses = null;
      }),
      drainer.transaction,
      LOADED,
    );
  });

  it("leaves a run unused when its balances do not match the message's keys", async () => {
    for (const change of [
      (value: Record<string, unknown>) => {
        value.preBalances = (value.preBalances as number[]).slice(1);
      },
      (value: Record<string, unknown>) => {
        value.postBalances = [...(value.postBalances as number[]), 0];
      },
    ]) {
      await notUsed(
        changed(change),
        drainer.transaction,
        "the simulation did not return the balances of its own run",
      );
    }
  });
});
