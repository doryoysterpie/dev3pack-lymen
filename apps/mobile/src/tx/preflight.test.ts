import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodePublicKey } from "../qr/base58.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import {
  forSigning,
  preflight,
  signingAllowed,
  type Preflight,
} from "./preflight.ts";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  DEVNET_GENESIS_HASH,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs.ts";
import type { Fetch } from "./rpc.ts";
import { parseTransaction } from "./wire.ts";

interface FixtureCase {
  readonly name: string;
  readonly transaction: string;
  readonly tables: Readonly<Record<string, readonly string[]>>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly cases: readonly FixtureCase[];
};

const USER = fixture.user;
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

interface Rpc {
  genesis?: string;
  before: Record<string, { lamports: number; owner: string; data: string }>;
  after: Record<string, { lamports: number; owner: string; data: string }>;
  err?: unknown;
  down?: boolean;
}

/** A fake JSON-RPC endpoint that answers from the maps it is given. */
function fakeRpc(rpc: Rpc): { fetch: Fetch; methods: string[] } {
  const methods: string[] = [];
  const answer = (map: Rpc["before"], address: string) => {
    const state = map[address];
    return state === undefined
      ? null
      : {
          lamports: state.lamports,
          owner: state.owner,
          data: [state.data, "base64"],
          executable: false,
          rentEpoch: 0,
        };
  };
  const fetch: Fetch = async (_url, init) => {
    if (rpc.down) throw new Error("network down");
    const request = JSON.parse(init.body) as {
      id: number;
      method: string;
      params: unknown[];
    };
    methods.push(request.method);
    let result: unknown;
    if (request.method === "getGenesisHash") {
      result = rpc.genesis ?? DEVNET_GENESIS_HASH;
    } else if (request.method === "getMultipleAccounts") {
      const addresses = request.params[0] as string[];
      result = {
        context: { slot: 1 },
        value: addresses.map((a) => answer(rpc.before, a)),
      };
    } else if (request.method === "simulateTransaction") {
      const options = request.params[1] as {
        accounts: { addresses: string[] };
      };
      result = {
        context: { slot: 1 },
        value: {
          err: rpc.err ?? null,
          logs: ["Program log: fake"],
          accounts: options.accounts.addresses.map((a) => answer(rpc.after, a)),
          unitsConsumed: 1234,
        },
      };
    } else {
      throw new Error(`unexpected method ${request.method}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: request.id, result }),
    };
  };
  return { fetch, methods };
}

const drainerRpc: Rpc = {
  before: {
    [USER]: { lamports: 5_000_000_000, owner: SYSTEM_PROGRAM, data: "" },
    [USER_TOKEN_ACCOUNT]: {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM,
      data: tokenAccount(USER, "1000", null, "0"),
    },
    [tableKey]: {
      lamports: 1,
      owner: ADDRESS_LOOKUP_TABLE_PROGRAM,
      data: lookupTableData(tableAddresses),
    },
  },
  after: {
    [USER]: { lamports: 9_995_000, owner: SYSTEM_PROGRAM, data: "" },
    [USER_TOKEN_ACCOUNT]: {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM,
      data: tokenAccount(USER, "1000", ATTACKER, U64_MAX),
    },
    [ATTACKER]: { lamports: 4_990_000_000, owner: SYSTEM_PROGRAM, data: "" },
  },
};

const ready = (result: Preflight) => {
  assert.equal(result.kind, "ready");
  return result as Extract<Preflight, { kind: "ready" }>;
};

describe("E-09 done test: the drainer pre-flight", () => {
  it("simulates the drainer and shows SOL balance out and the delegate approved", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const result = ready(
      await preflight(
        fetch,
        "https://devnet.example",
        drainer.transaction,
        USER,
      ),
    );
    assert.deepEqual(
      result.summary.effects.map((effect) => effect.kind),
      ["sol-out", "delegate-approved"],
    );
    assert.deepEqual(result.simulation, {
      status: "ran",
      err: null,
      logs: ["Program log: fake"],
      changes: [
        { kind: "sol", account: USER, before: "5000000000", after: "9995000" },
        {
          kind: "token",
          account: USER_TOKEN_ACCOUNT,
          mint: MINT,
          before: "1000",
          after: "1000",
          delegateBefore: null,
          delegateAfter: ATTACKER,
          delegatedAmountAfter: U64_MAX,
          ownerAfter: USER,
        },
      ],
    });
    assert.deepEqual(result.blocks, []);
  });

  it("loads lookup tables through the RPC, so the v0 drainer names the attacker", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const result = ready(
      await preflight(
        fetch,
        "https://devnet.example",
        drainerV0.transaction,
        USER,
      ),
    );
    assert.equal(result.summary.unresolvedAccounts, 0);
    const out = result.summary.effects[0];
    assert.ok(out.kind === "sol-out");
    assert.deepEqual(out.to, { address: ATTACKER });
  });
});

describe("pre-flight paths", () => {
  it("stops at an endpoint that is not devnet", async () => {
    const { fetch, methods } = fakeRpc({ ...drainerRpc, genesis: MINT });
    assert.deepEqual(
      await preflight(fetch, "https://x.example", drainer.transaction, USER),
      { kind: "not-devnet" },
    );
    assert.deepEqual(methods, ["getGenesisHash"]);
  });

  it("still decodes when the RPC cannot be reached, and says the simulation did not run", async () => {
    const { fetch } = fakeRpc({ ...drainerRpc, down: true });
    const result = ready(
      await preflight(fetch, "https://x.example", drainer.transaction, USER),
    );
    assert.equal(result.simulation.status, "not-run");
    assert.equal(result.summary.effects.length, 2);
  });

  it("passes a simulation error through for an unknown program, without a crash", async () => {
    const err = { InstructionError: [1, "InvalidInstructionData"] };
    const { fetch } = fakeRpc({ ...drainerRpc, err });
    const result = ready(
      await preflight(
        fetch,
        "https://x.example",
        caseNamed("unknown program").transaction,
        USER,
      ),
    );
    assert.deepEqual(
      result.summary.undecoded.map((u) => u.reason),
      ["unknown-program"],
    );
    assert.ok(result.simulation.status === "ran");
    assert.deepEqual(result.simulation.err, err);
  });

  it("blocks signing when a co-signer has not signed", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const result = ready(
      await preflight(
        fetch,
        "https://x.example",
        caseNamed("a co-signer that has not signed").transaction,
        USER,
      ),
    );
    assert.deepEqual(result.blocks, ["cosigner-missing"]);
  });

  it("allows a sponsored transaction whose fee payer has signed", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const result = ready(
      await preflight(
        fetch,
        "https://x.example",
        caseNamed("a co-signer that has signed").transaction,
        USER,
      ),
    );
    assert.deepEqual(result.blocks, []);
  });

  it("blocks signing for a wallet the transaction does not ask to sign", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const other = "GsJrhpq3YeSBYmKAtkbQFjYN9EoLJvVJvfvs9pTQ84Hc";
    const result = ready(
      await preflight(fetch, "https://x.example", drainer.transaction, other),
    );
    // To this wallet, the fixture user is another required signer with no
    // signature, which the specification also has wallets reject.
    assert.deepEqual(result.blocks, [
      "user-not-a-signer",
      "cosigner-missing",
      "fee-payer-not-user",
    ]);
  });

  it("refuses text that is not base64 and a truncated transaction", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    assert.deepEqual(
      await preflight(fetch, "https://x.example", "not base64!", USER),
      { kind: "malformed", problem: "not-base64" },
    );
    const bytes = decodeBase64(drainer.transaction);
    assert.ok(bytes !== null);
    const cut = encodeBase64(bytes.slice(0, 200));
    assert.deepEqual(await preflight(fetch, "https://x.example", cut, USER), {
      kind: "malformed",
      problem: "truncated",
    });
  });
});

describe("signing gate", () => {
  it("allows signing only after this transaction's card is shown", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const result = await preflight(
      fetch,
      "https://x.example",
      drainer.transaction,
      USER,
    );
    assert.equal(signingAllowed(result, null), false);
    assert.equal(
      signingAllowed(result, caseNamed("unknown program").transaction),
      false,
    );
    assert.equal(signingAllowed(result, drainer.transaction), true);
  });

  it("never allows signing a blocked transaction, shown or not", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const c = caseNamed("a co-signer that has not signed");
    const result = await preflight(
      fetch,
      "https://x.example",
      c.transaction,
      USER,
    );
    assert.equal(signingAllowed(result, c.transaction), false);
  });

  it("replaces only the blockhash of an unsigned transaction", async () => {
    const { fetch } = fakeRpc(drainerRpc);
    const result = ready(
      await preflight(fetch, "https://x.example", drainer.transaction, USER),
    );
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
    const { fetch } = fakeRpc(drainerRpc);
    const c = caseNamed("a co-signer that has signed");
    const result = ready(
      await preflight(fetch, "https://x.example", c.transaction, USER),
    );
    assert.equal(
      forSigning(result, "GsJrhpq3YeSBYmKAtkbQFjYN9EoLJvVJvfvs9pTQ84Hc"),
      c.transaction,
    );
  });
});
