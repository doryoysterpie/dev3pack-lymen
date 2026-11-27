// Solana Pay transaction request: the POST to the link (E-09).
//
// Follows the Solana Pay specification at solana-foundation/pay 8e1b87c,
// "POST Request" and "POST Response": the wallet POSTs {"account": <base58>}
// and the application answers {"transaction": <base64>} with an optional
// "message". fetch is passed in, so the tests need no network.

import type { Fetch } from "./rpc.ts";

export interface TransactionResponse {
  readonly transaction: string;
  readonly message: string | null;
}

export class RequestError extends Error {
  readonly reason: "http" | "not-json" | "no-transaction";
  constructor(reason: RequestError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export async function requestTransaction(
  fetch: Fetch,
  link: string,
  account: string,
): Promise<TransactionResponse> {
  const response = await fetch(link, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ account }),
  });
  if (!response.ok) {
    throw new RequestError("http", `the link answered HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RequestError("not-json", "the link did not answer with JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new RequestError(
      "not-json",
      "the link did not answer with an object",
    );
  }
  const { transaction, message } = body as Record<string, unknown>;
  if (typeof transaction !== "string" || transaction.length === 0) {
    throw new RequestError("no-transaction", "the answer holds no transaction");
  }
  return {
    transaction,
    message: typeof message === "string" && message.length > 0 ? message : null,
  };
}
