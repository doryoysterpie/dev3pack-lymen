// Solana Pay transaction request: the POST to the link (E-09).
//
// Follows the Solana Pay specification at solana-foundation/pay 8e1b87c,
// "POST Request" and "POST Response": the wallet POSTs {"account": <base58>}
// and the application answers {"transaction": <base64>} with an optional
// "message". fetch is passed in, so the tests need no network.

import {
  readAnswer,
  RPC_TIMEOUT_MS,
  withTimeout,
  type Fetch,
  type FetchResponse,
} from "@limen/preflight";

export interface TransactionResponse {
  readonly transaction: string;
  readonly message: string | null;
}

export class RequestError extends Error {
  readonly reason:
    "http" | "not-json" | "no-transaction" | "redirected" | "timeout";
  constructor(reason: RequestError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

const withoutFragment = (url: string): string => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
};

/**
 * POSTs the account to the link. The answer, its body read as text, must
 * arrive within timeoutMs, or the request fails with a timeout. The fetch
 * gives plain data ({ ok, status, url, text }, @limen/preflight's Fetch), and
 * the text is parsed here, so no method is called on what it returns.
 */
export async function requestTransaction(
  fetch: Fetch,
  link: string,
  account: string,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<TransactionResponse> {
  const late = () =>
    new RequestError(
      "timeout",
      `the link did not answer within ${timeoutMs / 1000} seconds`,
    );
  const sent = fetch(link, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ account }),
  });
  const raw = await withTimeout(sent, timeoutMs, late);
  let response: FetchResponse;
  try {
    response = readAnswer(raw);
  } catch {
    throw new RequestError("not-json", "the link did not answer with text");
  }
  // fetch follows redirects, and its answer's url is the final URL with no
  // fragment (on Android, the URL OkHttp last requested). Any difference
  // from the link, or no URL at all, is refused, so limen shows only what
  // the link itself answered. A 307 or 308 redirect has already resent the
  // POST, account included, to wherever it pointed (README).
  if (withoutFragment(response.url) !== withoutFragment(link)) {
    throw new RequestError(
      "redirected",
      "the request was redirected to another address, so limen will not show what it answered",
    );
  }
  if (!response.ok) {
    throw new RequestError("http", `the link answered HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(response.text);
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
