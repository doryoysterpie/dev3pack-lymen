// E-06, offline part: the pass mint and revoke transactions carry the owed instructions and
// parameters. The on-chain results (transfer fails, delegate burn succeeds) are checked against
// devnet by src/devnet/pass-mint.check.ts, which needs a funded key and does not run in CI.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  ACCOUNT_SIZE,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeBurnCheckedInstruction,
  decodeInitializeMintInstruction,
  decodeMintToInstruction,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TokenInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import {
  buildPassMintTransaction,
  buildRevokeTransaction,
  DEVNET_GENESIS_HASH,
  DEVNET_URL,
  devnetConnection,
  mintPass,
  passAccountLen,
  passFields,
  passMintState,
  passTokenAccount,
  revokePass,
  tokenMetadataLen,
} from "./pass-mint.ts";
import {
  accountInfoResult,
  sendAnswers,
  withDevnetStub,
  type RpcAnswer,
} from "./rpc-stub.ts";

const organizer = Keypair.generate();
const mint = Keypair.generate();
const holder = Keypair.generate().publicKey;
const DETAILS = {
  station: "st-front",
  session: "build-window",
  checkedInAt: 1_795_811_665,
};

function build(details = DETAILS) {
  return buildPassMintTransaction({
    organizer: organizer.publicKey,
    mint: mint.publicKey,
    holder,
    details,
    lamports: 4_181_760,
  });
}

test("the pass carries station, session and the check-in time in UTC as metadata fields", () => {
  assert.deepEqual(passFields(DETAILS), [
    ["station", "st-front"],
    ["session", "build-window"],
    ["checked_in_at", "2026-11-27T20:34:25Z"],
  ]);
});

test("the mint account size is the owed 274-byte mint plus a 4-byte TLV header plus its metadata", () => {
  // Base mint 82 bytes, padded to 165, plus 1 account-type byte: 166. Then TLV entries of
  // 4-byte header plus value: NonTransferable 0, PermanentDelegate 32, MetadataPointer 64.
  const mintLen = 166 + (4 + 0) + (4 + 32) + (4 + 64);
  assert.equal(mintLen, 274);
  // Metadata: authority 32 + mint 32 + "limen check-in pass" (4+19) + "LIMEN" (4+5) + "" (4+0)
  // + pair count 4 + station (4+7, 4+8) + session (4+7, 4+12) + checked_in_at (4+13, 4+20).
  const metadataLen = 64 + 23 + 9 + 4 + 4 + (11 + 12) + (11 + 16) + (17 + 24);
  assert.equal(
    tokenMetadataLen("limen check-in pass", "LIMEN", "", passFields(DETAILS)),
    metadataLen,
  );
  assert.equal(passAccountLen(DETAILS), mintLen + 4 + metadataLen);
  assert.equal(passAccountLen(DETAILS), 473);
});

test("the mint transaction creates a non-transferable mint with the organizer as permanent delegate", () => {
  const ix = build().instructions;
  assert.deepEqual(
    ix.map((i) => i.programId.toBase58()),
    [
      SystemProgram.programId,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    ].map((p) => p.toBase58()),
  );

  const create = SystemInstruction.decodeCreateAccount(ix[0]!);
  assert.equal(create.fromPubkey.toBase58(), organizer.publicKey.toBase58());
  assert.equal(create.newAccountPubkey.toBase58(), mint.publicKey.toBase58());
  assert.equal(create.space, 274);
  assert.equal(create.lamports, 4_181_760);
  assert.equal(create.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());

  // NonTransferable on the mint.
  assert.deepEqual(
    [...ix[1]!.data],
    [TokenInstruction.InitializeNonTransferableMint],
  );
  assert.equal(ix[1]!.keys[0]!.pubkey.toBase58(), mint.publicKey.toBase58());

  // PermanentDelegate = organizer.
  assert.equal(ix[2]!.data[0], TokenInstruction.InitializePermanentDelegate);
  assert.deepEqual(ix[2]!.data.subarray(1), organizer.publicKey.toBuffer());

  // MetadataPointer: authority organizer, metadata address the mint itself.
  assert.equal(ix[3]!.data[0], TokenInstruction.MetadataPointerExtension);
  assert.deepEqual(ix[3]!.data.subarray(2, 34), organizer.publicKey.toBuffer());
  assert.deepEqual(ix[3]!.data.subarray(34, 66), mint.publicKey.toBuffer());

  const init = decodeInitializeMintInstruction(
    ix[4]!,
    TOKEN_2022_PROGRAM_ID,
  ).data;
  assert.equal(init.decimals, 0);
  assert.equal(init.mintAuthority.toBase58(), organizer.publicKey.toBase58());
  assert.equal(init.freezeAuthority, null);
});

test("the metadata is written on the mint with the pass name, symbol and fields", () => {
  const ix = build().instructions;
  const text = (i: number) => ix[i]!.data.toString("latin1");
  assert.deepEqual(
    ix[5]!.keys.map((k) => k.pubkey.toBase58()),
    [
      mint.publicKey,
      organizer.publicKey,
      mint.publicKey,
      organizer.publicKey,
    ].map((k) => k.toBase58()),
  );
  assert.ok(
    text(5).includes("limen check-in pass") && text(5).includes("LIMEN"),
  );
  assert.ok(text(6).includes("station") && text(6).includes("st-front"));
  assert.ok(text(7).includes("session") && text(7).includes("build-window"));
  assert.ok(
    text(8).includes("checked_in_at") &&
      text(8).includes("2026-11-27T20:34:25Z"),
  );
  for (const i of [6, 7, 8]) {
    assert.equal(ix[i]!.keys[0]!.pubkey.toBase58(), mint.publicKey.toBase58());
    assert.equal(
      ix[i]!.keys[1]!.pubkey.toBase58(),
      organizer.publicKey.toBase58(),
    );
  }
});

test("exactly one token is minted to the holder's Token-2022 associated account", () => {
  const ix = build().instructions;
  const tokenAccount = passTokenAccount(mint.publicKey, holder);
  assert.deepEqual(
    ix[9]!.keys.slice(0, 4).map((k) => k.pubkey.toBase58()),
    [organizer.publicKey, tokenAccount, holder, mint.publicKey].map((k) =>
      k.toBase58(),
    ),
  );
  const mintTo = decodeMintToInstruction(ix[10]!, TOKEN_2022_PROGRAM_ID);
  assert.equal(mintTo.data.amount, 1n);
  assert.equal(
    mintTo.keys.destination.pubkey.toBase58(),
    tokenAccount.toBase58(),
  );
  assert.equal(
    mintTo.keys.authority.pubkey.toBase58(),
    organizer.publicKey.toBase58(),
  );
});

test("a pass with 64-character station and session IDs still fits in one transaction", () => {
  const tx = build({
    station: "s".repeat(64),
    session: "t".repeat(64),
    checkedInAt: 1_795_811_665,
  });
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.sign(organizer, mint);
  const size = tx.serialize().length;
  assert.ok(
    size <= 1232,
    `serialized size ${size} is over the 1232-byte limit`,
  );
  // At an address that already holds lamports, the top-up, allocate and assign still fit.
  const funded = buildPassMintTransaction({
    organizer: organizer.publicKey,
    mint: mint.publicKey,
    holder,
    details: {
      station: "s".repeat(64),
      session: "t".repeat(64),
      checkedInAt: 1_795_811_665,
    },
    lamports: 5_000_000,
    funded: 1_000_000,
  });
  funded.recentBlockhash = Keypair.generate().publicKey.toBase58();
  funded.sign(organizer, mint);
  assert.equal(funded.instructions.length, tx.instructions.length + 2);
  assert.ok(funded.serialize().length <= 1232);
});

test("station and session IDs over 64 bytes of UTF-8 are refused, before anything is sent", async () => {
  // At the limit, in ASCII and in two-byte characters, the pass builds and fits.
  for (const id of ["s".repeat(64), "é".repeat(32)]) {
    const tx = build({ station: id, session: id, checkedInAt: 1_795_811_665 });
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.sign(organizer, mint);
    assert.ok(tx.serialize().length <= 1232);
  }
  // One byte over, in either field, is refused with the field named.
  assert.throws(() => passFields({ ...DETAILS, station: "s".repeat(65) }), {
    message: "station is 65 bytes of UTF-8; a pass allows at most 64",
  });
  assert.throws(() => build({ ...DETAILS, session: "é".repeat(32) + "t" }), {
    message: "session is 65 bytes of UTF-8; a pass allows at most 64",
  });
  // mintPass refuses before it asks the cluster anything.
  await withDevnetStub(
    () => DEVNET_GENESIS_HASH,
    async (calls) => {
      await assert.rejects(
        mintPass(organizer, holder, { ...DETAILS, session: "t".repeat(65) }),
        { message: "session is 65 bytes of UTF-8; a pass allows at most 64" },
      );
      assert.deepEqual(calls, []);
    },
  );
});

test("the revoke transaction burns the holder's one token with the organizer as signer", () => {
  const tx = buildRevokeTransaction({
    organizer: organizer.publicKey,
    mint: mint.publicKey,
    holder,
  });
  assert.equal(tx.instructions.length, 1);
  const burn = decodeBurnCheckedInstruction(
    tx.instructions[0]!,
    TOKEN_2022_PROGRAM_ID,
  );
  assert.equal(
    burn.keys.account.pubkey.toBase58(),
    passTokenAccount(mint.publicKey, holder).toBase58(),
  );
  assert.equal(burn.keys.mint.pubkey.toBase58(), mint.publicKey.toBase58());
  assert.equal(
    burn.keys.owner.pubkey.toBase58(),
    organizer.publicKey.toBase58(),
  );
  assert.equal(burn.keys.owner.isSigner, true);
  assert.equal(burn.data.amount, 1n);
  assert.equal(burn.data.decimals, 0);
});

test("DEVNET_GENESIS_HASH is devnet's genesis hash", () => {
  // getGenesisHash read from api.devnet.solana.com on 2026-11-28. The other tests build their
  // stand-in connections from the constant, so only this literal catches a wrong value in it.
  assert.equal(
    DEVNET_GENESIS_HASH,
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
});

/** A genesis hash that is not devnet's. A stand-in, so no other cluster's value is in the repo. */
const NOT_DEVNET = "SomeOtherGenesisHash1111111111111111111111";
const NOT_DEVNET_MESSAGE =
  /^SOLANA_RPC_URL is not devnet: its genesis hash is SomeOtherGenesisHash1+\. limen runs on devnet only \(D-03\)\.$/;

/** Answers from a table, by method; an unlisted method fails the request. */
const table =
  (answers: Record<string, unknown>): RpcAnswer =>
  (method) => {
    if (!(method in answers)) throw new Error(`unexpected method ${method}`);
    return answers[method];
  };

test("the module has one devnet connection: it exports nothing that makes one, and no helper takes a connection or an endpoint", async () => {
  const mod = await import("./pass-mint.ts");
  // Exactly these functions and the one error class: none makes a connection, and only
  // devnetConnection returns one.
  assert.deepEqual(
    Object.keys(mod)
      .filter((name) => typeof mod[name as keyof typeof mod] === "function")
      .sort(),
    [
      "MintAddressOccupiedError",
      "buildPassMintTransaction",
      "buildRevokeTransaction",
      "devnetConnection",
      "mintPass",
      "passAccountLen",
      "passFields",
      "passMintState",
      "passTokenAccount",
      "revokePass",
      "tokenMetadataLen",
    ],
  );
  assert.equal(devnetConnection(), devnetConnection(), "one connection");
  assert.equal(devnetConnection().rpcEndpoint, DEVNET_URL);
  // Their parameters, before the optional mint keypair: keys and details only.
  assert.deepEqual(
    [mintPass.length, revokePass.length, passMintState.length],
    [3, 3, 2],
  );
});

test("every request mintPass, passMintState and revokePass send goes to the devnet endpoint with redirects refused", async () => {
  await withDevnetStub(
    table({
      getGenesisHash: DEVNET_GENESIS_HASH,
      getMinimumBalanceForRentExemption: 4_181_760,
      getAccountInfo: accountInfoResult(null),
      ...sendAnswers("5".repeat(88)),
    }),
    async (calls) => {
      await mintPass(organizer, holder, DETAILS);
      assert.deepEqual(
        calls.map((c) => c.method),
        [
          "getGenesisHash",
          "getAccountInfo",
          "getMinimumBalanceForRentExemption",
          "getLatestBlockhash",
          "sendTransaction",
          "getSignatureStatuses",
        ],
      );
      assert.equal(await passMintState(mint.publicKey, holder), "absent");
      await revokePass(organizer, mint.publicKey, holder);
      assert.ok(calls.length > 5);
      for (const call of calls) {
        assert.equal(call.url, DEVNET_URL, call.method);
        assert.equal(call.redirect, "error", call.method);
      }
    },
  );
});

/** Reads a request's body as text. */
async function bodyOf(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text;
}

/** Listens on `host` at a free port and returns the server's base URL. */
async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return `http://${host}:${(server.address() as AddressInfo).port}`;
}

test("a helper's request fails on a redirect to another host, where the same request without its redirect setting follows it", async () => {
  const hits: string[] = [];
  const target = createServer(async (req, res) => {
    hits.push("target");
    const { id } = JSON.parse(await bodyOf(req)) as { id: unknown };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id, result: DEVNET_GENESIS_HASH }),
    );
  });
  const targetUrl = await listen(target, "localhost");
  const endpoint = createServer((_req, res) => {
    hits.push("endpoint");
    res.writeHead(307, { location: `${targetUrl}/` });
    res.end();
  });
  const endpointUrl = await listen(endpoint, "127.0.0.1");
  // Each request the module sends is carried to the local endpoint as the module made it, or
  // with its redirect setting dropped, so nothing reaches devnet.
  const real = globalThis.fetch;
  const carry = (keepRedirect: boolean) =>
    (async (_input: unknown, init?: RequestInit) => {
      const sent = keepRedirect ? init : { ...init, redirect: undefined };
      return real(endpointUrl, sent);
    }) as typeof fetch;
  try {
    globalThis.fetch = carry(true);
    await assert.rejects(passMintState(mint.publicKey, holder));
    assert.deepEqual(hits, ["endpoint"], "nothing reaches the target");
    hits.length = 0;
    // Control: the same request without redirect "error" follows the 307 to the target.
    globalThis.fetch = carry(false);
    await passMintState(mint.publicKey, holder).catch(() => undefined);
    assert.deepEqual(hits.slice(0, 2), ["endpoint", "target"]);
  } finally {
    globalThis.fetch = real;
    for (const server of [endpoint, target])
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("mintPass, revokePass and passMintState refuse a cluster whose genesis hash is not devnet's with their first request, before anything is sent (D-03)", async () => {
  for (const run of [
    () => mintPass(organizer, holder, DETAILS),
    () => revokePass(organizer, mint.publicKey, holder),
    () => passMintState(mint.publicKey, holder),
  ]) {
    await withDevnetStub(
      table({ getGenesisHash: NOT_DEVNET }),
      async (calls) => {
        await assert.rejects(run(), { message: NOT_DEVNET_MESSAGE });
        assert.deepEqual(
          calls.map((c) => c.method),
          ["getGenesisHash"],
        );
      },
    );
  }
});

test("mintPass creates the pass at the mint keypair it is given", async () => {
  const given = Keypair.generate();
  let sent: Transaction | undefined;
  await withDevnetStub(
    (method, params) => {
      if (method === "sendTransaction")
        sent = Transaction.from(Buffer.from(String(params[0]), "base64"));
      return table({
        getGenesisHash: DEVNET_GENESIS_HASH,
        getAccountInfo: accountInfoResult(null),
        getMinimumBalanceForRentExemption: 4_181_760,
        ...sendAnswers("5".repeat(88)),
      })(method, params);
    },
    async () => {
      const minted = await mintPass(organizer, holder, DETAILS, given);
      assert.equal(minted.mint.toBase58(), given.publicKey.toBase58());
      assert.equal(minted.signature, "5".repeat(88));
    },
  );
  assert.ok(sent !== undefined);
  assert.equal(
    SystemInstruction.decodeCreateAccount(
      sent.instructions[0]!,
    ).newAccountPubkey.toBase58(),
    given.publicKey.toBase58(),
  );
});

/** A Token-2022 mint account's data, as spl-token lays it out. */
function mintData(supply: bigint, decimals = 0): Buffer {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: organizer.publicKey,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

/** A token account's data, as spl-token lays it out. */
function tokenAccountData(
  ofMint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: ofMint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

/** getAccountInfo answers from `accounts`, failing for the addresses in `failing`. */
const accountsAnswer =
  (
    accounts: ReadonlyMap<string, Buffer>,
    failing: ReadonlySet<string> = new Set(),
  ): RpcAnswer =>
  (method, params) => {
    if (method === "getGenesisHash") return DEVNET_GENESIS_HASH;
    if (method !== "getAccountInfo")
      throw new Error(`unexpected method ${method}`);
    const address = String(params[0]);
    if (failing.has(address)) throw new Error("node is unhealthy");
    const data = accounts.get(address);
    return accountInfoResult(
      data === undefined
        ? null
        : { owner: TOKEN_2022_PROGRAM_ID.toBase58(), data },
    );
  };

test("passMintState says minted only for the holder's one token of that mint; any other initialized Token-2022 mint or unheld token account there is unheld, and a failed request is an error", async () => {
  const passMint = Keypair.generate().publicKey;
  const account = passTokenAccount(passMint, holder);
  const accounts = new Map([
    [passMint.toBase58(), mintData(1n)],
    [account.toBase58(), tokenAccountData(passMint, holder, 1n)],
  ]);
  await withDevnetStub(accountsAnswer(accounts), async () =>
    assert.equal(await passMintState(passMint, holder), "minted"),
  );
  // At the holder's address, a token of another mint, or another owner's; a mint with decimals;
  // and the pass burned to a supply of 0.
  for (const [address, data] of [
    [account, tokenAccountData(Keypair.generate().publicKey, holder, 1n)],
    [account, tokenAccountData(passMint, Keypair.generate().publicKey, 1n)],
    [passMint, mintData(1n, 6)],
    [passMint, mintData(0n)],
  ] as const) {
    const changed = new Map(accounts).set(address.toBase58(), data);
    await withDevnetStub(accountsAnswer(changed), async () =>
      assert.equal(await passMintState(passMint, holder), "unheld"),
    );
  }
  // The holder's account could not be read: that is no fact about the chain.
  await withDevnetStub(
    accountsAnswer(accounts, new Set([account.toBase58()])),
    async () => {
      await assert.rejects(
        passMintState(passMint, holder),
        /node is unhealthy/,
      );
    },
  );
});
