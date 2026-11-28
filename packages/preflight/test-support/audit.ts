// Test support, not part of the package's exports (E-09): the fixture keys,
// a clean recorded devnet run and the checks shared by the tests for the
// owner's audit of 6c4e64e.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as spl from "@solana/spl-token";
import * as web3 from "@solana/web3.js";

import { decodePublicKey } from "../src/base58.ts";
import { encodeBase64 } from "../src/base64.ts";
import { drainPattern } from "../src/drain.ts";
import {
  preflight,
  signingAllowed,
  toReport,
  type Preflight,
} from "../src/preflight.ts";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  SYSTEM_PROGRAM,
} from "../src/programs.ts";
import type { RpcEndpoint } from "../src/rpc.ts";
import { legacy } from "./build.ts";
import {
  endpointFor,
  recordedEndpoint,
  type RecordedAccount,
} from "./recorded.ts";

export const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/tx/e09-transactions.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly user: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly cases: readonly {
    readonly name: string;
    readonly transaction: string;
    readonly tables: Readonly<Record<string, readonly string[]>>;
  }[];
};
export const USER = fixture.user;
export const {
  attacker: ATTACKER,
  mint: MINT,
  lookupTable: TABLE,
} = fixture.keys;
export const ACCOUNT = fixture.keys.userTokenAccount;
export const caseNamed = (start: string) => {
  const found = fixture.cases.find((c) => c.name.startsWith(start));
  assert.ok(found, start);
  return found;
};
export const drainer = caseNamed("drainer: SOL balance out").transaction;
export const loadedV0 = caseNamed(
  "drainer as a v0 transaction, attacker address in a loaded",
);
// Any 32-byte value: the blockhash the run replaces, and the one it reports.
export const BLOCKHASH = "GktecGbUNfCx8DDQSQYK9CKuFoN95ca2JdPYz6pZLeiW";
export const OTHER = web3.PublicKey.unique().toBase58();
export const user = new web3.PublicKey(USER);
export const account = new web3.PublicKey(ACCOUNT);
export const attacker = new web3.PublicKey(ATTACKER);
export const mint = new web3.PublicKey(MINT);
export const T22 = spl.TOKEN_2022_PROGRAM_ID;

export const wallet = (lamports: number): RecordedAccount => ({
  lamports,
  owner: SYSTEM_PROGRAM,
  data: ["", "base64"],
});
export function lookupTableData(addresses: readonly string[]): string {
  const data = new Uint8Array(56 + 32 * addresses.length);
  data[0] = 1;
  addresses.forEach((address, i) => {
    const key = decodePublicKey(address);
    assert.ok(key !== null);
    data.set(key, 56 + 32 * i);
  });
  return encodeBase64(data);
}

/** A devnet endpoint whose run is clean, recorded as agave writes it. */
export const clean = (): RpcEndpoint =>
  recordedEndpoint({
    accounts: {
      [USER]: wallet(5_000_000_000),
      [TABLE]: {
        lamports: 1,
        owner: ADDRESS_LOOKUP_TABLE_PROGRAM,
        data: [lookupTableData(loadedV0.tables[TABLE]), "base64"],
      },
    },
    simulation: {
      err: null,
      accounts: {},
      slot: 7,
      replacementBlockhash: BLOCKHASH,
    },
    latestBlockhash: BLOCKHASH,
  });

export const ready = (result: Preflight) => {
  assert.equal(result.kind, "ready");
  return result as Extract<Preflight, { kind: "ready" }>;
};
export const notRun = async (endpoint: RpcEndpoint, transaction = drainer) => {
  const result = ready(await preflight(endpoint, transaction, USER));
  assert.equal(result.simulation.status, "not-run");
  assert.ok(result.blocks.includes("simulation-not-run"));
  assert.equal(signingAllowed(result, result.base64), false);
  return result.simulation.reason;
};

// Instructions built with @solana/spl-token, the wallet signing as owner.
export const SPL = spl.TOKEN_PROGRAM_ID;
export const tx = (...instructions: web3.TransactionInstruction[]) =>
  legacy(USER, instructions, BLOCKHASH);
export const offline = endpointFor(async () => {
  throw new Error("offline");
}, "x");
export const drainsOffline = async (transaction: string) =>
  drainPattern(toReport(ready(await preflight(offline, transaction, USER))));
