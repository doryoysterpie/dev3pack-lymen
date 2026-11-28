// Test support, not part of the package's exports (E-09): an RPC endpoint
// whose fetch answers from recorded RPC data instead of the network, as JSON
// text, so the pre-flight reads it through its own JSON-RPC client.

import { messageAccounts, type LookupTables } from "../src/accounts.ts";
import { decodeBase64 } from "../src/base64.ts";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  DEVNET_GENESIS_HASH,
} from "../src/programs.ts";
import type { Fetch, RpcEndpoint } from "../src/rpc.ts";
import { parseLookupTable } from "../src/state.ts";
import { parseTransaction } from "../src/wire.ts";

/**
 * An account as getMultipleAccounts and simulateTransaction return it with
 * base64 encoding.
 */
export interface RecordedAccount {
  readonly lamports: number;
  readonly owner: string;
  readonly data: readonly [string, "base64"];
  readonly executable?: boolean;
  readonly rentEpoch?: number;
  readonly space?: number;
}

export interface Recording {
  /** getGenesisHash's result. Devnet's when left out. */
  readonly genesisHash?: string;
  /** Account state before the simulation, by address. Absent when left out. */
  readonly accounts: Readonly<Record<string, RecordedAccount | null>>;
  /**
   * simulateTransaction's value, with its accounts by address. An address
   * left out of accounts is recorded as unchanged: its post state is its
   * state in Recording.accounts, as are its post balances.
   */
  readonly simulation: {
    readonly err: unknown;
    readonly logs?: readonly string[];
    readonly unitsConsumed?: number;
    readonly accounts: Readonly<Record<string, RecordedAccount | null>>;
    /** The response context's slot. */
    readonly slot?: number;
    /** The blockhash the simulation used in place of the transaction's own. */
    readonly replacementBlockhash?: string;
    /**
     * Leaves out preBalances, postBalances and the token balances, which the
     * recording otherwise derives: before from accounts, after from these
     * accounts where they name an address, for every account the
     * transaction lists.
     */
    readonly omitBalances?: boolean;
  };
  /** getLatestBlockhash's blockhash. */
  readonly latestBlockhash?: string;
}

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

type AccountMap = Readonly<Record<string, RecordedAccount | null>>;

/** The transaction's account list, its lookup tables read from the map. */
function keysOf(base64: string, map: AccountMap): (string | null)[] {
  const bytes = decodeBase64(base64);
  const parsed = bytes === null ? null : parseTransaction(bytes);
  if (parsed === null || !parsed.ok) return [];
  const tables = new Map<string, readonly string[]>();
  for (const lookup of parsed.transaction.message.lookups) {
    const state = map[lookup.table];
    const data = state ? decodeBase64(state.data[0]) : null;
    const addresses =
      state && state.owner === ADDRESS_LOOKUP_TABLE_PROGRAM && data !== null
        ? parseLookupTable(data)
        : null;
    if (addresses !== null) tables.set(lookup.table, addresses);
  }
  return messageAccounts(
    parsed.transaction.message,
    tables as LookupTables,
  ).map((account) => account.address);
}

const byAddress = (
  map: Readonly<Record<string, RecordedAccount | null>>,
  addresses: readonly string[],
) => addresses.map((address) => map[address] ?? null);

/** An endpoint whose fetch answers every call from the recording. */
export function recordedEndpoint(recording: Recording): RpcEndpoint {
  const fetch: Fetch = async (_url, init) => {
    const request = JSON.parse(init.body) as Request;
    let result: unknown;
    switch (request.method) {
      case "getGenesisHash":
        result = recording.genesisHash ?? DEVNET_GENESIS_HASH;
        break;
      case "getMultipleAccounts":
        result = {
          context: { slot: 0 },
          value: byAddress(recording.accounts, request.params[0] as string[]),
        };
        break;
      case "simulateTransaction": {
        const { slot, replacementBlockhash } = recording.simulation;
        const keys = keysOf(request.params[0] as string, recording.accounts);
        const pre = (address: string) => recording.accounts[address] ?? null;
        const post = (address: string) =>
          address in recording.simulation.accounts
            ? (recording.simulation.accounts[address] ?? null)
            : pre(address);
        const balances = recording.simulation.omitBalances
          ? {}
          : {
              preBalances: keys.map((k) =>
                k === null ? 0 : (pre(k)?.lamports ?? 0),
              ),
              postBalances: keys.map((k) =>
                k === null ? 0 : (post(k)?.lamports ?? 0),
              ),
              preTokenBalances: [],
              postTokenBalances: [],
            };
        result = {
          context: { slot: slot ?? 0 },
          value: {
            replacementBlockhash:
              replacementBlockhash === undefined
                ? null
                : { blockhash: replacementBlockhash, lastValidBlockHeight: 0 },
            err: recording.simulation.err,
            logs: recording.simulation.logs ?? [],
            unitsConsumed: recording.simulation.unitsConsumed ?? 0,
            // As the balances above: an address left out is unchanged.
            // limen asks for no account, so none is returned.
            accounts: null,
            ...balances,
          },
        };
        break;
      }
      case "getLatestBlockhash":
        result = {
          context: { slot: 0 },
          value: {
            blockhash: recording.latestBlockhash ?? "",
            lastValidBlockHeight: 0,
          },
        };
        break;
      default:
        return {
          ok: true,
          status: 200,
          url: "recorded:",
          text: JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: `not recorded: ${request.method}` },
          }),
        };
    }
    return {
      ok: true,
      status: 200,
      url: "recorded:",
      text: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    };
  };
  return { url: "recorded:", fetch };
}

/** An endpoint for a test's own fetch. */
export function endpointFor(
  fetch: Fetch,
  url: string,
  timeoutMs?: number,
): RpcEndpoint {
  return timeoutMs === undefined ? { url, fetch } : { url, fetch, timeoutMs };
}
