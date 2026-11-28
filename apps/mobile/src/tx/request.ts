// Solana Pay transaction request: the POST to the link (E-09).
//
// Follows the Solana Pay specification at solana-foundation/pay 8e1b87c,
// "POST Request" and "POST Response": the wallet POSTs {"account": <base58>}
// and the application answers {"transaction": <base64>} with an optional
// "message". fetch is passed in, so the tests need no network.

import {
  isJsonObject,
  parseJson,
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
    | "http"
    | "not-json"
    | "no-transaction"
    | "redirected"
    | "no-final-url"
    | "timeout";
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
  if (link === "") {
    throw new RequestError(
      "http",
      "limen was given no request link, so limen could not tell where to ask",
    );
  }
  const late = new RequestError(
    "timeout",
    `the link did not answer within ${timeoutMs / 1000} seconds`,
  );
  let raw: unknown;
  try {
    raw = await withTimeout(
      fetch(link, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ account }),
      }),
      timeoutMs,
      () => late,
    );
  } catch (error) {
    throw error === late
      ? late
      : new RequestError("http", "the link could not be reached");
  }
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
  // POST, account included, to wherever it pointed (README). An answer with
  // no final URL is not called redirected: limen cannot tell where it came
  // from (the audit of 6c4e64e, Major 9).
  if (response.url === "") {
    throw new RequestError(
      "no-final-url",
      "the answer gave no final URL, so limen cannot confirm it came from the link and will not show what it answered",
    );
  }
  if (withoutFragment(response.url) !== withoutFragment(link)) {
    throw new RequestError(
      "redirected",
      "the request was redirected to another address, so limen will not show what it answered",
    );
  }
  if (response.status === 0) {
    throw new RequestError(
      "http",
      "the answer gave no HTTP status, so limen could not tell whether the request succeeded",
    );
  }
  if (!response.ok) {
    throw new RequestError(
      "http",
      response.status === 200
        ? "the answer was not marked ok, so limen could not tell whether the request succeeded"
        : `the link answered HTTP ${response.status}`,
    );
  }
  // Read by the package's one JSON reader, as every RPC answer is, so an
  // answer that names a member twice holds no transaction limen reads (the
  // audit of 6c4e64e, Major 1, swept to the link's answer).
  const parsed = parseJson(response.text);
  if (!parsed.ok) {
    throw new RequestError(
      "not-json",
      parsed.problem === "repeated-member"
        ? "the link's answer names a member twice"
        : "the link did not answer with JSON",
    );
  }
  const body = parsed.value;
  if (!isJsonObject(body)) {
    throw new RequestError(
      "not-json",
      "the link did not answer with an object",
    );
  }
  const transaction = body.get("transaction");
  const message = body.get("message");
  if (typeof transaction !== "string" || transaction.length === 0) {
    throw new RequestError("no-transaction", "the answer holds no transaction");
  }
  return {
    transaction,
    message: typeof message === "string" && message.length > 0 ? message : null,
  };
}

/**
 * The text shown on the Stopped step when a request, wallet or signing step
 * fails; an absent or empty message yields "limen could not tell".
 */
export function stoppedReason(error: unknown): string {
  try {
    const text =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    return text.length > 0
      ? text
      : "limen could not tell why the request stopped";
  } catch {
    return "limen could not tell why the request stopped";
  }
}
