// E-05 app half: the flow verifies the QR on the device, has the wallet sign the owed message,
// and posts a check-in whose signature verifies the way the backend checks it.
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CHECKIN_MESSAGES } from "./client.ts";
import { parseApiUrl, parseStationSigners } from "./config.ts";
import {
  FLOW_MESSAGES,
  prepareCheckin,
  type CheckinFlowDeps,
  type WalletAccount,
  type WalletSigner,
} from "./flow.ts";
import type { CheckinResult } from "./client.ts";
import type { Ed25519Verify } from "./station-qr.ts";
import { ed25519Verify } from "./ed25519.ts";
import { mwaSigner, type MwaWallet, type Transact } from "./mwa-signer.ts";
import { encodeBase58 } from "./wallet-address.ts";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/station-qr/e05-app.json", import.meta.url),
    "utf8",
  ),
) as {
  issued_at: number;
  nonce: string;
  organizer_signer_id: string;
  valid: string;
  stranger: string;
};
const T = FIXTURE.issued_at;
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const spki = (key: Uint8Array) =>
  createPublicKey({
    key: Buffer.concat([SPKI, key]),
    format: "der",
    type: "spki",
  });
const nodeVerify: Ed25519Verify = (key, message, signature) =>
  verify(null, message, spki(key), signature);

/**
 * A wallet that connects as one account and signs whatever bytes it is asked to, recording each
 * step in `events` and each signed message in `signed`.
 */
function fakeWallet(
  opts: { declineConnect?: boolean; declineSign?: boolean } = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  );
  const address = encodeBase58(key);
  const account: WalletAccount = {
    wallet: address,
    key,
    address: key.toString("base64"),
    authToken: "auth-token-1",
  };
  const events: string[] = [];
  const signed: Uint8Array[] = [];
  const signer: WalletSigner = {
    async connect() {
      events.push("connect");
      if (opts.declineConnect) throw new Error("user declined");
      return account;
    },
    async sign(as, message) {
      events.push("sign");
      if (opts.declineSign) throw new Error("user declined");
      assert.equal(as, account, "it signs as the account it connected");
      signed.push(message);
      return sign(null, message, privateKey);
    },
  };
  return { key, address, events, signed, signer, privateKey };
}

/** A server that checks the signature as the backend does, by rebuilding the message. */
function fakeServer(walletKey: Buffer) {
  const posted: Record<string, unknown>[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<
      string,
      string | null
    >;
    posted.push(body);
    const payload = JSON.parse(
      Buffer.from(String(body.qr).split(".")[1] ?? "", "base64url").toString(),
    ) as Record<string, string>;
    const message = [
      "limen check-in v2",
      `station: ${payload.station}`,
      `session: ${payload.session}`,
      `nonce: ${payload.nonce}`,
      `wallet: ${body.wallet}`,
    ].join("\n");
    const ok = verify(
      null,
      Buffer.from(message, "utf8"),
      spki(walletKey),
      Buffer.from(String(body.signature), "base64"),
    );
    return ok
      ? new Response(
          JSON.stringify({
            status: "checked_in",
            station: "st-front",
            session: "day-2",
            mint: "Mint1",
            signature: "Sig1",
          }),
          { status: 201 },
        )
      : new Response(JSON.stringify({ error: "bad_wallet_signature" }), {
          status: 401,
        });
  }) as unknown as typeof fetch;
  return { fn, posted };
}

function deps(
  wallet: ReturnType<typeof fakeWallet>,
  server: ReturnType<typeof fakeServer>,
  clock: () => number = () => T + 10,
): CheckinFlowDeps {
  return {
    apiBase: "http://10.0.2.2:8787",
    allowlist: new Set([FIXTURE.organizer_signer_id]),
    nowMs: () => clock() * 1000,
    verify: nodeVerify,
    signer: wallet.signer,
    fetchFn: server.fn,
  };
}

/** Prepares a check-in and, if it is ready, signs it: the panel's two steps, run at once. */
async function prepareAndSign(
  d: CheckinFlowDeps,
  input: { qr: string; registrationText: string },
): Promise<CheckinResult> {
  const prepared = await prepareCheckin(d, input);
  return prepared.ok ? prepared.sign() : prepared;
}

test("nothing is signed while preparing: prepareCheckin gives its five lines without the registration ID, and only sign() has the wallet sign, exactly those bytes", async () => {
  const wallet = fakeWallet();
  const server = fakeServer(wallet.key);
  const prepared = await prepareCheckin(deps(wallet, server), {
    qr: FIXTURE.valid,
    registrationText: "  LMN-0001 ",
  });
  assert.ok(prepared.ok);
  // What the panel shows before its Sign this message action: the account and nonce included,
  // and no registration ID.
  assert.deepEqual(prepared.preview.lines, [
    "limen check-in v2",
    "station: st-front",
    "session: day-2",
    `nonce: ${FIXTURE.nonce}`,
    `wallet: ${wallet.address}`,
  ]);
  assert.deepEqual(wallet.events, ["connect"], "connected, nothing signed");
  assert.equal(server.posted.length, 0);
  const result = await prepared.sign();
  assert.deepEqual(wallet.events, ["connect", "sign"]);
  assert.deepEqual(
    Buffer.from(wallet.signed[0]!),
    Buffer.from(prepared.preview.lines.join("\n"), "ascii"),
    "the bytes signed are the lines shown",
  );
  assert.deepEqual(
    Buffer.from(wallet.signed[0]!),
    Buffer.from(prepared.preview.bytes),
  );
  assert.deepEqual(result, {
    ok: true,
    station: "st-front",
    session: "day-2",
    mint: "Mint1",
    signature: "Sig1",
  });
  assert.deepEqual(server.posted, [
    {
      qr: FIXTURE.valid,
      wallet: wallet.address,
      registration_id: "LMN-0001",
      signature: Buffer.from(
        sign(null, prepared.preview.bytes, wallet.privateKey),
      ).toString("base64"),
    },
  ]);
});

test("a QR that expires while its message is on screen is refused at sign(), before the wallet signs or the server hears", async () => {
  const wallet = fakeWallet();
  const server = fakeServer(wallet.key);
  let now = T + 10;
  const prepared = await prepareCheckin(
    deps(wallet, server, () => now),
    {
      qr: FIXTURE.valid,
      registrationText: "",
    },
  );
  assert.ok(prepared.ok);
  now = T + 61;
  assert.deepEqual(await prepared.sign(), {
    ok: false,
    error: "station_qr_expired",
    message: CHECKIN_MESSAGES.station_qr_expired,
  });
  assert.deepEqual(wallet.events, ["connect"]);
  assert.equal(server.posted.length, 0);
});

test("a QR whose signature the device could not check is refused as unchecked, not as failing the check", async () => {
  const wallet = fakeWallet();
  const server = fakeServer(wallet.key);
  const throwing: Ed25519Verify = () => {
    throw new Error("library failure");
  };
  assert.deepEqual(
    await prepareCheckin(
      { ...deps(wallet, server), verify: throwing },
      { qr: FIXTURE.valid, registrationText: "" },
    ),
    {
      ok: false,
      error: "station_qr_unchecked",
      message: FLOW_MESSAGES.qr_unchecked,
    },
  );
  assert.equal(
    FLOW_MESSAGES.qr_unchecked,
    "The app could not check this station QR's signature. Nothing was sent.",
  );
  assert.deepEqual(wallet.events, []);
  assert.equal(server.posted.length, 0);
});

test("an expired or foreign QR, or a malformed registration ID, stops before the wallet or the server", async () => {
  const cases: [string, string, number, string][] = [
    [FIXTURE.valid, "LMN-0001", T + 61, "station_qr_expired"],
    [FIXTURE.stranger, "LMN-0001", T + 10, "station_qr_invalid"],
    [FIXTURE.valid, "LMN 0001", T + 10, "invalid_registration_id"],
  ];
  for (const [qr, registrationText, now, error] of cases) {
    const wallet = fakeWallet();
    const server = fakeServer(wallet.key);
    const result = await prepareCheckin(
      deps(wallet, server, () => now),
      {
        qr,
        registrationText,
      },
    );
    assert.deepEqual(
      result,
      { ok: false, error, message: CHECKIN_MESSAGES[error] },
      error,
    );
    assert.deepEqual(wallet.events, [], `${error}: nothing reaches the wallet`);
    assert.equal(
      server.posted.length,
      0,
      `${error}: nothing reaches the server`,
    );
  }
});

test("a wallet that does not connect, or does not sign, sends nothing, and no API URL means no check-in at all", async () => {
  const notConnecting = fakeWallet({ declineConnect: true });
  const server = fakeServer(notConnecting.key);
  assert.deepEqual(
    await prepareCheckin(deps(notConnecting, server), {
      qr: FIXTURE.valid,
      registrationText: "",
    }),
    {
      ok: false,
      error: "wallet_not_connected",
      message: FLOW_MESSAGES.wallet_not_connected,
    },
  );
  const declining = fakeWallet({ declineSign: true });
  assert.deepEqual(
    await prepareAndSign(deps(declining, server), {
      qr: FIXTURE.valid,
      registrationText: "",
    }),
    {
      ok: false,
      error: "wallet_declined",
      message: FLOW_MESSAGES.wallet_declined,
    },
  );
  assert.equal(server.posted.length, 0);
  const wallet = fakeWallet();
  assert.deepEqual(
    await prepareCheckin(
      { ...deps(wallet, server), apiBase: null },
      { qr: FIXTURE.valid, registrationText: "" },
    ),
    { ok: false, error: "no_server", message: FLOW_MESSAGES.no_server },
  );
  assert.deepEqual(wallet.events, []);
});

test("a later check-in without a registration ID signs the same five lines and posts registration_id null", async () => {
  const wallet = fakeWallet();
  const server = fakeServer(wallet.key);
  assert.equal(
    (
      await prepareAndSign(deps(wallet, server), {
        qr: FIXTURE.valid,
        registrationText: "",
      })
    ).ok,
    true,
  );
  assert.equal(
    Buffer.from(wallet.signed[0]!).toString("ascii"),
    [
      "limen check-in v2",
      "station: st-front",
      "session: day-2",
      `nonce: ${FIXTURE.nonce}`,
      `wallet: ${wallet.address}`,
    ].join("\n"),
  );
  assert.equal(server.posted[0]!.registration_id, null);
});

/** Collects every string and decoded base64 string inside a value passed to MWA. */
function collectMwaStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (decoded.length > 0) out.push(decoded);
  } else if (value instanceof Uint8Array) {
    out.push(Buffer.from(value).toString("utf8"));
  } else if (Array.isArray(value)) {
    for (const item of value) collectMwaStrings(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectMwaStrings(v, out);
    }
  }
  return out;
}

test("nothing passed to MWA contains the registration ID, which travels only in the POST body", async () => {
  const registrationId = "LMN-SECRET-9876";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  );
  const mwaParams: unknown[] = [];
  const wallet: MwaWallet = {
    async authorize(params) {
      mwaParams.push(params);
      return {
        accounts: [{ address: key.toString("base64") }],
        auth_token: "token-1",
      };
    },
    async signMessages(params) {
      mwaParams.push(params);
      const msg = Buffer.from(params.payloads[0] ?? "", "base64");
      const sig = sign(null, msg, privateKey);
      return {
        signed_payloads: [Buffer.concat([msg, sig]).toString("base64")],
      };
    },
  };
  const transact: Transact = (cb) => cb(wallet);
  const signer = mwaSigner(transact, {
    appName: "limen",
    chain: "solana:devnet",
    verify: ed25519Verify,
  });
  const server = fakeServer(key);
  const result = await prepareAndSign(
    {
      apiBase: "http://10.0.2.2:8787",
      allowlist: new Set([FIXTURE.organizer_signer_id]),
      nowMs: () => (T + 10) * 1000,
      verify: ed25519Verify,
      signer,
      fetchFn: server.fn,
    },
    { qr: FIXTURE.valid, registrationText: `  ${registrationId}  ` },
  );
  assert.equal(mwaParams.length, 3, "authorize, re-authorize, signMessages");
  const seenStrings = collectMwaStrings(mwaParams);
  const regBase64 = Buffer.from(registrationId, "utf8").toString("base64");
  for (const s of seenStrings) {
    assert.doesNotMatch(
      s,
      new RegExp(`${registrationId}|registration`, "i"),
      `MWA received registration data: ${s}`,
    );
    assert.equal(
      s.includes(regBase64),
      false,
      `MWA received base64 registration ID: ${s}`,
    );
  }
  assert.equal(result.ok, true);
  assert.equal(server.posted.length, 1);
  assert.equal(server.posted[0]!.registration_id, registrationId);
});

test("the API URL must be https://, except http:// on localhost, 127.0.0.1 and 10.0.2.2, and any other http:// base stops before the wallet or the server", async () => {
  for (const [good, expected] of [
    ["https://api.example.test", "https://api.example.test"],
    [" https://api.example.test/ ", "https://api.example.test"],
    ["https://api.example.test:8443/v1///", "https://api.example.test:8443/v1"],
    ["http://localhost:8787/", "http://localhost:8787"],
    ["http://LOCALHOST:8787/", "http://localhost:8787"],
    ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
    ["http://10.0.2.2:8787/", "http://10.0.2.2:8787"],
  ] as const) {
    assert.equal(parseApiUrl(good), expected, good);
  }
  for (const bad of [
    undefined,
    "",
    "10.0.2.2:8787",
    "ftp://x",
    "http://a b",
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
    "https://user:pass@api.example.test",
    "https://api.example.test?next=1",
    "https://api.example.test#frag",
    "https://api.example.test\\@evil.test",
  ]) {
    assert.equal(parseApiUrl(bad), null, String(bad));
  }

  // Even if a caller hands prepareCheckin an unparsed non-loopback http:// base directly, it
  // refuses before connecting the wallet or sending any request.
  const wallet = fakeWallet();
  const server = fakeServer(wallet.key);
  assert.deepEqual(
    await prepareCheckin(
      { ...deps(wallet, server), apiBase: "http://api.example.test:8787" },
      { qr: FIXTURE.valid, registrationText: "LMN-0001" },
    ),
    { ok: false, error: "no_server", message: FLOW_MESSAGES.no_server },
  );
  assert.deepEqual(wallet.events, []);
  assert.equal(server.posted.length, 0);

  assert.deepEqual(
    [
      ...parseStationSigners(
        ` ${FIXTURE.organizer_signer_id} , short, ${"A".repeat(43)}`,
      ),
    ],
    [FIXTURE.organizer_signer_id, "A".repeat(43)],
  );
  assert.equal(parseStationSigners(undefined).size, 0);
});
