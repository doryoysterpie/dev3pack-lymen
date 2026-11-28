import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  CHECKIN_MESSAGES,
  checkinBody,
  postCheckin,
  type CheckinRequest,
} from "./client.ts";
import { appFetch } from "./http.ts";

const API = "https://api.example.test";
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
  assert.equal(seen[0]!.init?.redirect, "error");
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

test("postCheckin refuses any http:// base other than localhost, 127.0.0.1 and 10.0.2.2 before sending any request", async () => {
  for (const good of [
    "https://api.example.test/",
    "http://localhost:8787/",
    "http://127.0.0.1:8787/",
    "http://10.0.2.2:8787/",
  ]) {
    const { fn, seen } = answering(201, {
      status: "checked_in",
      station: "st-front",
      session: "day-2",
      mint: "Mint1111",
      signature: "Sig1111",
    });
    assert.equal((await postCheckin(fn, good, REQ)).ok, true, good);
    assert.equal(seen.length, 1, good);
  }
  for (const bad of [
    "http://api",
    "http://api.example.test",
    "http://api.example.test:8787",
    "http://192.168.1.10:8787",
    "http://127.0.0.2:8787",
    "http://10.0.2.3:8787",
    "http://0.0.0.0:8787",
    "http://[::1]:8787",
    "http://localhost.evil.test:8787",
    "http://localhost@evil.test:8787",
    "https://api.example.test?next=1",
    "https://api.example.test#frag",
    "ftp://api.example.test",
    "",
  ]) {
    const { fn, seen } = answering(201, {
      status: "checked_in",
      station: "st-front",
      session: "day-2",
      mint: "Mint1111",
      signature: "Sig1111",
    });
    assert.deepEqual(
      await postCheckin(fn, bad, REQ),
      {
        ok: false,
        error: "invalid_api_url",
        message:
          "The check-in server URL must use https://, or http:// on localhost, 127.0.0.1 or 10.0.2.2.",
      },
      bad,
    );
    assert.equal(seen.length, 0, `${bad}: no request sent`);
  }
});

test("a check-in the backend completes from the chain, with no transaction signature, is a check-in", async () => {
  // E-05's backend answers 201 with a null signature when a retry finds the pass already held by
  // the wallet at its mint address, so nothing new was sent (services/api/README.md, Minting).
  const checkedIn = {
    status: "checked_in",
    station: "st-front",
    session: "day-2",
    mint: "Mint1111",
  };
  assert.deepEqual(
    await postCheckin(
      answering(201, { ...checkedIn, signature: null }).fn,
      API,
      REQ,
    ),
    {
      ok: true,
      station: "st-front",
      session: "day-2",
      mint: "Mint1111",
      signature: null,
    },
  );
  // A signature that is neither text nor null, or none at all, is still not a check-in.
  for (const body of [{ ...checkedIn, signature: 7 }, checkedIn])
    assert.equal(
      (await postCheckin(answering(201, body).fn, API, REQ)).ok,
      false,
    );
});

test("after mint_failed the participant reads that the pass may already be in the wallet, and how to finish", async () => {
  // A 502 mint_failed leaves the check-in pending; the pass may have landed (services/api/README.md).
  assert.deepEqual(
    await postCheckin(answering(502, { error: "mint_failed" }).fn, API, REQ),
    {
      ok: false,
      error: "mint_failed",
      message:
        "The pass may already be in your wallet. Try again to finish the check-in.",
    },
  );
});

test("a check-in whose pass was revoked reads as revoked, not as a server failure", async () => {
  // E-05's backend answers 409 pass_revoked once a pass issued for the check-in has been burned.
  assert.deepEqual(
    await postCheckin(answering(409, { error: "pass_revoked" }).fn, API, REQ),
    {
      ok: false,
      error: "pass_revoked",
      message: "The pass for this check-in was revoked.",
    },
  );
});

test("each refusal the backend gives becomes its sentence", async () => {
  for (const [error, status] of [
    ["already_checked_in", 409],
    ["station_qr_expired", 400],
    ["no_registration_binding", 403],
    ["check_in_unavailable", 503],
  ] as const) {
    const result = await postCheckin(answering(status, { error }).fn, API, REQ);
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
  assert.deepEqual(await postCheckin(down, API, REQ), {
    ok: false,
    error: "unreachable",
    message: "The check-in server cannot be reached.",
  });
  assert.deepEqual(
    await postCheckin(answering(500, { error: "constructor" }).fn, API, REQ),
    {
      ok: false,
      error: "constructor",
      message: "The server answered with status 500.",
    },
  );
  const notJson = (async () =>
    new Response("<html>", { status: 502 })) as unknown as typeof fetch;
  assert.deepEqual(await postCheckin(notJson, API, REQ), {
    ok: false,
    error: "status_502",
    message: "The server answered with status 502.",
  });
  // A 201 without the owed fields is not taken as a check-in.
  assert.equal(
    (await postCheckin(answering(201, { status: "checked_in" }).fn, API, REQ))
      .ok,
    false,
  );
});

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("307 and 308 redirects fail closed with no second request, where plain fetch resends the body", async () => {
  for (const status of [307, 308] as const) {
    const targetHits: { method: string | undefined; body: string }[] = [];
    const target = createServer(async (req, res) => {
      targetHits.push({ method: req.method, body: await readText(req) });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "checked_in",
          station: "st-front",
          session: "day-2",
          mint: "Mint1",
          signature: "Sig1",
        }),
      );
    });
    const targetUrl = await listen(target);
    let endpointHits = 0;
    const endpoint = createServer((_req, res) => {
      endpointHits += 1;
      res.writeHead(status, { location: `${targetUrl}/checkins` });
      res.end();
    });
    const endpointUrl = await listen(endpoint);
    try {
      const result = await postCheckin(globalThis.fetch, endpointUrl, REQ);
      assert.deepEqual(
        result,
        {
          ok: false,
          error: "unreachable",
          message: CHECKIN_MESSAGES.unreachable,
        },
        `status ${status} fails closed`,
      );
      assert.equal(endpointHits, 1, `status ${status}: one attempt only`);
      assert.equal(
        targetHits.length,
        0,
        `status ${status}: second origin receives nothing`,
      );

      // appFetch also forces redirect "error" even if a caller passes redirect "follow".
      await assert.rejects(
        appFetch(`${endpointUrl}/checkins`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: checkinBody(REQ),
          redirect: "follow",
        }),
      );
      assert.equal(
        endpointHits,
        2,
        `status ${status}: appFetch attempted once`,
      );
      assert.equal(
        targetHits.length,
        0,
        `status ${status}: appFetch never hits second origin`,
      );

      // Control: plain fetch without redirect "error" follows 307/308 and resends the body.
      const control = await globalThis.fetch(`${endpointUrl}/checkins`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: checkinBody(REQ),
      });
      assert.equal(control.status, 201);
      assert.equal(targetHits.length, 1);
      assert.equal(targetHits[0]!.method, "POST");
      assert.ok(targetHits[0]!.body.includes("LMN-0001"));
    } finally {
      for (const server of [endpoint, target])
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("a response JSON body that repeats a key is refused instead of collapsing to the last value", async () => {
  const raw = (status: number, body: string) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  for (const body of [
    '{"status":"checked_in","station":"st-front","session":"day-2","mint":"Mint1","mint":"Mint2","signature":"Sig1"}',
    '{"status":"checked_in","station":"st-front","session":"day-2","mint":"Mint1","m\\u0069nt":"Mint2","signature":"Sig1"}',
    '{"status":"other","status":"checked_in","station":"st-front","session":"day-2","mint":"Mint1","signature":"Sig1"}',
    '{"status":"checked_in","station":"st-front","session":"day-2","mint":"Mint1","signature":"Sig1","extra":{"a":1,"a":2}}',
  ]) {
    assert.deepEqual(
      await postCheckin(raw(201, body), API, REQ),
      {
        ok: false,
        error: "status_201",
        message: "The server answered with status 201.",
      },
      body,
    );
  }

  for (const body of [
    '{"error":"pass_revoked","error":"already_checked_in"}',
    '{"error":"already_checked_in","error":"pass_revoked"}',
    '{"error":"pass_revoked","err\\u006fr":"already_checked_in"}',
  ]) {
    assert.deepEqual(
      await postCheckin(raw(409, body), API, REQ),
      {
        ok: false,
        error: "status_409",
        message: "The server answered with status 409.",
      },
      body,
    );
  }
});
