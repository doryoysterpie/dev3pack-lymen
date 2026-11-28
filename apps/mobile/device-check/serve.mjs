// E-18: the device check's HTTPS server for the devnet fixture transaction requests.
//
// Run from the repository root, after make-certificates.mjs:
//   node apps/mobile/device-check/serve.mjs
//
// It listens on https://127.0.0.1:8443 only, which the Android emulator reaches as
// https://10.0.2.2:8443, with the server certificate from .certs/. The QR to scan reads
//   solana:https://10.0.2.2:8443/drainer
//
// POST /drainer answers a Solana Pay transaction request (solana-foundation/pay 8e1b87c,
// "POST Request" and "POST Response") with the E-09 drainer fixture, built for the account in
// the request. limen pre-flights only a transaction the user's wallet pays the fee for, so the
// posted account takes the place of the fixture's user: fee payer, SOL source and token
// authority. Everything else is the fixture's, as fixtures/tx/generate-e09.mjs builds it with
// the same @solana/web3.js and @solana/spl-token versions.
//
// Before it listens, the server builds the drainer for the fixture's own user and checks that
// the bytes equal the first case of fixtures/tx/e09-transactions.json. It exits if they do not.
//
// It logs each request's method, path and answer, and each TLS handshake that fails, such as
// a client refusing the test certificate. It logs no key.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";

import { createApproveInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const HOST = "127.0.0.1";
const PORT = 8443;
const MAX_BODY = 1024;

// As in fixtures/tx/generate-e09.mjs: every key is the SHA-256 of a fixed label, used as a
// public key, none made from a keypair.
const key = (label) =>
  new PublicKey(createHash("sha256").update(`limen-e09-${label}`).digest());
const attacker = key("attacker");
const userTokenAccount = key("user-token-account");
const blockhash = key("blockhash").toBase58();
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const U64_MAX = 18446744073709551615n;

/** The generator's drainer, with `user` as fee payer, SOL source and token authority. */
function drainerFor(user) {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
    new TransactionInstruction({
      programId: MEMO,
      keys: [],
      data: Buffer.from("Claim your limen pass", "ascii"),
    }),
    SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: attacker,
      lamports: 4.99e9,
    }),
    createApproveInstruction(
      userTokenAccount,
      attacker,
      user,
      U64_MAX,
      [],
      TOKEN_PROGRAM_ID,
    ),
  ];
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions,
  }).compileToLegacyMessage();
  const signatures = Array.from(
    { length: message.header.numRequiredSignatures },
    () => new Uint8Array(64),
  );
  return Buffer.from(
    new VersionedTransaction(message, signatures).serialize(),
  ).toString("base64");
}

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const fixture = JSON.parse(
  readFileSync(here("../../../fixtures/tx/e09-transactions.json"), "utf8"),
);
const owed = fixture.cases[0];
if (
  !owed.name.startsWith("drainer: ") ||
  drainerFor(new PublicKey(fixture.user)) !== owed.transaction
) {
  console.error(
    "serve: the drainer built for the fixture's user does not equal the fixture's drainer case; not serving.",
  );
  process.exit(1);
}

/** Reads the posted account, or returns null for anything but {"account": <public key>}. */
function accountOf(body) {
  try {
    const { account } = JSON.parse(body);
    if (typeof account !== "string") return null;
    const key = new PublicKey(account);
    return key.toBase58() === account ? key : null;
  } catch {
    return null;
  }
}

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

const server = createServer(
  {
    key: readFileSync(here(".certs/server-key.pem")),
    cert: readFileSync(here(".certs/server.pem")),
  },
  (req, res) => {
    const log = (status, note) =>
      console.log(`${req.method} ${req.url} -> ${status} ${note}`);
    if (req.url !== "/drainer" || req.method !== "POST") {
      log(404, "not served");
      return send(res, 404, { error: "not found" });
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      const account = accountOf(body);
      if (account === null) {
        log(400, "no account");
        return send(res, 400, {
          error: 'the body must be {"account": <public key>}',
        });
      }
      log(200, `drainer built for ${account.toBase58()}`);
      send(res, 200, { transaction: drainerFor(account) });
    });
  },
);
server.on("tlsClientError", (error) =>
  console.log(`TLS handshake failed: ${error.code ?? ""} ${error.message}`),
);
server.listen(PORT, HOST, () =>
  console.log(
    `serving the drainer fixture on https://${HOST}:${PORT}/drainer (the emulator's https://10.0.2.2:${PORT}/drainer)`,
  ),
);
