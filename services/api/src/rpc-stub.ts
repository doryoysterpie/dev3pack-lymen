// A stand-in for devnet's JSON-RPC, for tests (E-05). pass-mint.ts's one connection sends each
// request through globalThis.fetch, read at each call, so a test can answer it without the
// network. withDevnetStub installs the stand-in for one test and records every request it gets:
// the URL, the JSON-RPC method and params, and the request's redirect setting. A request to a
// local test server (127.0.0.1) goes to the real fetch; any other URL is refused, so nothing
// leaves the machine.

/** One request the stand-in answered. */
export interface RpcCall {
  readonly url: string;
  readonly method: string;
  readonly params: readonly unknown[];
  readonly redirect: RequestRedirect | undefined;
}

/** Answers one JSON-RPC method; throwing makes the stand-in answer with a JSON-RPC error. */
export type RpcAnswer = (method: string, params: readonly unknown[]) => unknown;

export const DEVNET_RPC = "https://api.devnet.solana.com";

export async function withDevnetStub<T>(
  answer: RpcAnswer,
  run: (calls: RpcCall[]) => Promise<T>,
): Promise<T> {
  const calls: RpcCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return real(input as string, init);
    if (url !== DEVNET_RPC)
      throw new Error(`the stand-in refuses a request to another URL`);
    const { id, method, params } = JSON.parse(String(init?.body)) as {
      id: unknown;
      method: string;
      params?: unknown[];
    };
    calls.push({ url, method, params: params ?? [], redirect: init?.redirect });
    let body: unknown;
    try {
      body = { jsonrpc: "2.0", id, result: await answer(method, params ?? []) };
    } catch (err) {
      body = {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (err as Error).message },
      };
    }
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

/** getAccountInfo's answer for an account owned by `owner` holding `data`, or for no account. */
export function accountInfoResult(
  account: { readonly owner: string; readonly data: Uint8Array } | null,
) {
  return {
    context: { slot: 1 },
    value:
      account === null
        ? null
        : {
            data: [Buffer.from(account.data).toString("base64"), "base64"],
            executable: false,
            lamports: 1_000_000,
            owner: account.owner,
            rentEpoch: 0,
            space: account.data.length,
          },
  };
}

/** The answers a transaction's send needs: a blockhash, the send, and a confirmed status. */
export function sendAnswers(signature: string) {
  return {
    getLatestBlockhash: {
      context: { slot: 1 },
      value: {
        blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        lastValidBlockHeight: 100,
      },
    },
    sendTransaction: signature,
    getSignatureStatuses: {
      context: { slot: 2 },
      value: [
        {
          slot: 2,
          confirmations: 1,
          err: null,
          confirmationStatus: "confirmed",
        },
      ],
    },
    getBlockHeight: 50,
  };
}
