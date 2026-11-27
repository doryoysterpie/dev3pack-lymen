// A recorded Rpc (E-09): it answers from recorded RPC data instead of the
// network, through the same JSON-RPC parsing as jsonRpc. For tests, and for a
// server that replays a recorded simulation with no network.

import { DEVNET_GENESIS_HASH } from "./programs.ts";
import { jsonRpc, type Fetch, type Rpc } from "./rpc.ts";

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
  /** simulateTransaction's value, with its accounts by address. */
  readonly simulation: {
    readonly err: unknown;
    readonly logs?: readonly string[];
    readonly unitsConsumed?: number;
    readonly accounts: Readonly<Record<string, RecordedAccount | null>>;
    /** The response context's slot. */
    readonly slot?: number;
    /** The blockhash the simulation used in place of the transaction's own. */
    readonly replacementBlockhash?: string;
  };
  /** getLatestBlockhash's blockhash. */
  readonly latestBlockhash?: string;
}

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

const byAddress = (
  map: Readonly<Record<string, RecordedAccount | null>>,
  addresses: readonly string[],
) => addresses.map((address) => map[address] ?? null);

/** An Rpc that answers every call from the recording. */
export function recordedRpc(recording: Recording): Rpc {
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
        const options = request.params[1] as {
          accounts: { addresses: string[] };
        };
        const { slot, replacementBlockhash } = recording.simulation;
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
            accounts: byAddress(
              recording.simulation.accounts,
              options.accounts.addresses,
            ),
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
          json: async () => ({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: `not recorded: ${request.method}` },
          }),
        };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: request.id, result }),
    };
  };
  return jsonRpc(fetch, "recorded:");
}
