import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECKIN_MESSAGES,
  postCheckin,
  type CheckinRequest,
} from "./client.ts";

const SIGNATURE = new Uint8Array(64).map((_, i) => i);
const REQ: CheckinRequest = {
  qr: "limen:station:v1.payload.signer.signature",
  wallet: "6mmVXu9m4A3FQsggw4qxZzyjkA6GX5XKDK1cMUcmTF14",
  registrationId: "LMN-0001",
  signature: SIGNATURE,
};

function answering(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

test("the check-in is POSTed as JSON to <API>/checkins with a standard base64 signature", async () => {
  const { fn, seen } = answering(201, {
    status: "checked_in",
    station: "st-front",
    session: "day-2",
    mint: "Mint1111",
    signature: "Sig1111",
  });
  const result = await postCheckin(fn, "http://10.0.2.2:8787/", REQ);
  assert.deepEqual(result, {
    ok: true,
    station: "st-front",
    session: "day-2",
    mint: "Mint1111",
    signature: "Sig1111",
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "http://10.0.2.2:8787/checkins");
  assert.equal(seen[0]!.init?.method, "POST");
  assert.deepEqual(seen[0]!.init?.headers, {
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), {
    qr: REQ.qr,
    wallet: REQ.wallet,
    registration_id: "LMN-0001",
    signature: Buffer.from(SIGNATURE).toString("base64"),
  });
});

test("each refusal the backend gives becomes its sentence", async () => {
  for (const [error, status] of [
    ["already_checked_in", 409],
    ["station_qr_expired", 400],
    ["no_registration_binding", 403],
    ["check_in_unavailable", 503],
  ] as const) {
    const result = await postCheckin(
      answering(status, { error }).fn,
      "http://api",
      REQ,
    );
    assert.deepEqual(result, {
      ok: false,
      error,
      message: CHECKIN_MESSAGES[error],
    });
  }
});

test("an unreachable server, an unknown error and a body that is not JSON each give a plain answer", async () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.deepEqual(await postCheckin(down, "http://api", REQ), {
    ok: false,
    error: "unreachable",
    message: "The check-in server cannot be reached.",
  });
  assert.deepEqual(
    await postCheckin(
      answering(500, { error: "constructor" }).fn,
      "http://api",
      REQ,
    ),
    {
      ok: false,
      error: "constructor",
      message: "The server answered with status 500.",
    },
  );
  const notJson = (async () =>
    new Response("<html>", { status: 502 })) as unknown as typeof fetch;
  assert.deepEqual(await postCheckin(notJson, "http://api", REQ), {
    ok: false,
    error: "status_502",
    message: "The server answered with status 502.",
  });
  // A 201 without the owed fields is not taken as a check-in.
  assert.equal(
    (
      await postCheckin(
        answering(201, { status: "checked_in" }).fn,
        "http://api",
        REQ,
      )
    ).ok,
    false,
  );
});
