// Check-in, backend half (E-05). Registration binding is E-07's (registration.ts) and pass
// minting is E-06's (mintPass, on pass-mint.ts's one devnet connection). checkIn reaches them through the
// two interfaces below, so tests can pass doubles; registrationsFrom and devnetMinter build the
// real ones, and the running API (index.ts) uses those.
//
// The app posts JSON to POST /checkins:
//
//   { "qr": <station QR text>, "wallet": <wallet address>,
//     "registration_id": <registration ID, or null after the first check-in>,
//     "signature": <base64 of the wallet's 64-byte Ed25519 signature> }
//
// The wallet signs the UTF-8 text checkinMessage() builds from the verified QR payload:
//
//   limen check-in v2
//   station: <station>
//   session: <session>
//   nonce: <nonce>
//   wallet: <wallet address>
//
// The registration ID is not in it: it travels only in the body, so no wallet or wallet adapter
// is handed it. v1 carried it on a sixth line.
// The backend checks in this order, and the first failure is the answer: the request's shape,
// the signature's form included; the station QR (allowlisted signer, signature, at most 60 s old
// at the millisecond clock); the station; the session still open; the wallet's key, in the
// prime-order subgroup; the wallet's signature over the message, under strict Ed25519 rules; the
// registration (the wallet's binding, or a first binding of registration_id); one check-in per
// registration per session. Only then does it mint, at the mint address derived for the check-in.
// services/api/README.md lists the answer each check gives, and checkin.test.ts holds the code
// and that list to this order.
import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { encodeBase58 } from "./base58.ts";
import type { OrganizerKey } from "./organizer-key.ts";
import {
  bindRegistration,
  decodeBase58,
  isWalletAddress,
  registrationForWallet,
} from "./registration.ts";
import {
  verifyStationQr,
  type StationPayload,
  type StationQrRejection,
} from "./station-qr.ts";

/** The reasons E-07's bindRegistration gives for refusing a binding. */
export type BindRefusal =
  | "invalid_registration_id"
  | "invalid_wallet"
  | "unknown_registration"
  | "registration_bound_to_other_wallet"
  | "wallet_bound_to_other_registration";

/** What E-05 needs from E-07. Each method names the E-07 function that backs it. */
export interface CheckinRegistrations {
  /** The 32-byte public key a wallet address names, or null (E-07: decodeBase58 and isWalletAddress). */
  walletKey(wallet: string): Uint8Array | null;
  /** The registration hash the wallet is bound to, or null (E-07: registrationForWallet). */
  bindingOf(wallet: string): string | null;
  /** Binds a registration to the wallet at its first check-in (E-07: bindRegistration). */
  bind(
    registrationId: string,
    wallet: string,
    now: number,
  ):
    | { readonly ok: true; readonly regHash: string }
    | { readonly ok: false; readonly reason: BindRefusal };
}

/** What E-05 needs from E-06 (E-06: mintPass and passMintState). */
export interface PassMinter {
  /**
   * Mints the pass to `wallet` at the address of the keypair `seed` gives, and confirms it. It
   * may fail before or after the pass lands; the caller reads `state` to tell which.
   */
  mint(
    wallet: string,
    seed: Uint8Array,
    details: {
      readonly station: string;
      readonly session: string;
      readonly checkedInAt: number;
    },
  ): Promise<{ readonly signature: string }>;
  /** Reads the chain at `mint`: no account, the pass held by `wallet`, or a pass it does not hold. */
  state(
    wallet: string,
    mint: string,
  ): Promise<"absent" | "minted" | "unheld" | "occupied">;
}

/**
 * The 32-byte seed of a check-in's pass mint keypair: HMAC-SHA256 under PASS_MINT_SECRET of
 * "limen:pass-mint:v1:<session>:<registration hash>". The same check-in always gets the same
 * mint address, so a retry cannot mint a second pass: a second createAccount at that address
 * fails. The registration hash is 64 hex characters, so the text names one session and hash.
 */
export function mintSeed(
  secret: string,
  session: string,
  regHash: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(`limen:pass-mint:v1:${session}:${regHash}`, "utf8")
    .digest();
}

/** The shortest PASS_MINT_SECRET accepted, as for REGISTRATION_SALT. */
const MIN_MINT_SECRET_LENGTH = 32;

/**
 * Reads PASS_MINT_SECRET. Unset, empty or shorter than 32 characters stops start-up, and the
 * error never echoes the value. Changing the secret moves every pending pass to an address this
 * API can no longer derive, so it is set once.
 */
export function loadPassMintSecret(value: string | undefined): string {
  if (value === undefined || value.length < MIN_MINT_SECRET_LENGTH) {
    throw new Error(
      `PASS_MINT_SECRET must be set to at least ${MIN_MINT_SECRET_LENGTH} characters (${value === undefined || value === "" ? "it is not set" : "it is too short"}). To add one to .env without printing it, run from the repository root: printf '\\nPASS_MINT_SECRET=%s\\n' "$(openssl rand -base64 32)" >> .env`,
    );
  }
  return value;
}

// DER header of a PKCS #8 Ed25519 private key holding a 32-byte seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** The base58 address of the Ed25519 keypair `seed` gives, as Keypair.fromSeed derives it. */
export function mintAddressFromSeed(seed: Uint8Array): string {
  const publicKey = createPublicKey(
    createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    }),
  );
  return encodeBase58(
    Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url"),
  );
}

/** E-07's registration binding on `db`, with registration IDs hashed under `salt`. */
export function registrationsFrom(
  db: DatabaseSync,
  salt: string,
): CheckinRegistrations {
  return {
    walletKey: (wallet) =>
      isWalletAddress(wallet) ? decodeBase58(wallet) : null,
    bindingOf: (wallet) => registrationForWallet(db, wallet),
    bind: (registrationId, wallet, now) => {
      const bound = bindRegistration(db, salt, registrationId, wallet, now);
      return bound.ok
        ? { ok: true, regHash: bound.regHash }
        : { ok: false, reason: bound.reason };
    },
  };
}

/**
 * The account at a check-in's mint address is one limen did not make, so no pass is minted over
 * it and the check-in answers 502 mint_address_occupied, staying pending for an operator.
 */
export class MintAddressOccupied extends Error {
  override name = "MintAddressOccupied";
  constructor(mint: string) {
    super(`mint address occupied: ${mint}`);
  }
}

/**
 * E-06's pass mint on devnet, paid for and signed by the organizer key. It reaches devnet only
 * through pass-mint.ts's one connection, which no caller can replace; each mint and each chain
 * read first refuses a cluster whose genesis hash is not devnet's. E-06's code and
 * @solana/web3.js load at the minter's first use, a mint or, for a check-in an earlier request or
 * process left pending, the chain read before it, so the API starts without them where no
 * check-in reaches the minter.
 */
export function devnetMinter(organizer: OrganizerKey): PassMinter {
  const load = async () => ({
    web3: await import("@solana/web3.js"),
    passes: await import("./pass-mint.ts"),
  });
  let loading: ReturnType<typeof load> | null = null;
  const loaded = () =>
    (loading ??= load().catch((err: unknown) => {
      loading = null;
      throw err;
    }));
  return {
    async mint(wallet, seed, details) {
      const { web3, passes } = await loaded();
      const mintKey = web3.Keypair.fromSeed(seed);
      try {
        const minted = await passes.mintPass(
          web3.Keypair.fromSecretKey(organizer.secretKeyBytes()),
          new web3.PublicKey(wallet),
          details,
          mintKey,
        );
        return { signature: minted.signature };
      } catch (err) {
        if (err instanceof passes.MintAddressOccupiedError)
          throw new MintAddressOccupied(mintKey.publicKey.toBase58());
        throw err;
      }
    },
    async state(wallet, mint) {
      const { web3, passes } = await loaded();
      return passes.passMintState(
        new web3.PublicKey(mint),
        new web3.PublicKey(wallet),
      );
    },
  };
}

export interface CheckinDeps {
  readonly db: DatabaseSync;
  /** Signer IDs allowed to sign station QRs (see stationAllowlist). */
  readonly allowlist: ReadonlySet<string>;
  readonly registrations: CheckinRegistrations;
  readonly minter: PassMinter;
  /** PASS_MINT_SECRET, which each pass's mint keypair is derived from (mintSeed). */
  readonly mintSecret: string;
}

export interface CheckinOutcome {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

interface CheckinRequest {
  readonly qr: string;
  readonly wallet: string;
  readonly registrationId: string | null;
  readonly signature: Buffer;
}

/** The fields a refusal may name. A response names no other field and carries no client string. */
type RequestField = "body" | "qr" | "wallet" | "registration_id" | "signature";

const REQUEST_KEYS: ReadonlySet<string> = new Set<RequestField>([
  "qr",
  "wallet",
  "registration_id",
  "signature",
]);
const MAX_FIELD_CHARS = 1024;

/** The order L of Ed25519's prime-order subgroup (RFC 8032 section 5.1). */
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

type Noble = typeof import("@noble/curves/ed25519.js");
let noble: Promise<Noble> | null = null;
/** @noble/curves 2.4.0, loaded at the first check, so the API starts where nothing checks in. */
const loadNoble = (): Promise<Noble> =>
  (noble ??= import("@noble/curves/ed25519.js"));

/**
 * True when `bytes` decodes, under RFC 8032's canonical rules (y below p, no sign bit on x = 0),
 * to a point of the prime-order subgroup other than the identity: no small or mixed order.
 */
function primeOrderPoint(ed: Noble, bytes: Uint8Array): boolean {
  try {
    const point = ed.ed25519.Point.fromBytes(bytes, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
}

/** True when `key` is a canonically encoded Ed25519 public key in the prime-order subgroup. */
export async function walletKeyAcceptable(key: Uint8Array): Promise<boolean> {
  return key.length === 32 && primeOrderPoint(await loadNoble(), key);
}

/**
 * Strict Ed25519 verification of a wallet's signature. The key and the signature's R must each be
 * canonically encoded and in the prime-order subgroup, S must be below L, and then noble's RFC
 * 8032 check, with ZIP-215 off, must pass.
 */
export async function walletSignatureValid(
  key: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (key.length !== 32 || signature.length !== 64) return false;
  const ed = await loadNoble();
  const s = BigInt(
    `0x${Buffer.from(signature.subarray(32)).reverse().toString("hex")}`,
  );
  return (
    s < ED25519_L &&
    primeOrderPoint(ed, key) &&
    primeOrderPoint(ed, signature.subarray(0, 32)) &&
    ed.ed25519.verify(signature, message, key, { zip215: false })
  );
}

/** The exact text the wallet signs. It holds no registration ID, which travels only in the body. */
export function checkinMessage(p: {
  station: string;
  session: string;
  nonce: string;
  wallet: string;
}): string {
  return [
    "limen check-in v2",
    `station: ${p.station}`,
    `session: ${p.session}`,
    `nonce: ${p.nonce}`,
    `wallet: ${p.wallet}`,
  ].join("\n");
}

function parseRequest(
  body: unknown,
):
  | { ok: true; req: CheckinRequest }
  | { ok: false; field: RequestField }
  | { ok: false; field: null } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { ok: false, field: "body" };
  const b = body as Record<string, unknown>;
  // A key outside the four fields is refused without naming it.
  for (const key of Object.keys(b))
    if (!REQUEST_KEYS.has(key)) return { ok: false, field: null };
  const text = (v: unknown) =>
    typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD_CHARS;
  if (!text(b.qr)) return { ok: false, field: "qr" };
  if (!text(b.wallet) || /[\r\n]/.test(b.wallet as string))
    return { ok: false, field: "wallet" };
  const reg = b.registration_id ?? null;
  if (reg !== null && (!text(reg) || /[\r\n]/.test(reg as string)))
    return { ok: false, field: "registration_id" };
  if (typeof b.signature !== "string") return { ok: false, field: "signature" };
  const signature = Buffer.from(b.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== b.signature)
    return { ok: false, field: "signature" };
  return {
    ok: true,
    req: {
      qr: b.qr as string,
      wallet: b.wallet as string,
      registrationId: reg as string | null,
      signature,
    },
  };
}

/**
 * A refusal body, built only from fixed codes: the error, a field from RequestField, and a
 * reason from the station QR verifier or "unexpected_field". Nothing the client sent is copied in.
 */
const refuse = (
  status: number,
  error:
    | "invalid_request"
    | "station_qr_expired"
    | "station_qr_invalid"
    | "unknown_station"
    | "session_closed"
    | "bad_wallet_signature"
    | "no_registration_binding"
    | "already_checked_in"
    | "pass_revoked"
    | "mint_failed"
    | "mint_address_occupied"
    | BindRefusal,
  extra:
    | { readonly field: RequestField }
    | { readonly reason: StationQrRejection | "unexpected_field" }
    | Record<string, never> = {},
): CheckinOutcome => ({
  status,
  body: { error, ...extra },
});

/**
 * Runs one check-in at Unix time `nowMs`, in milliseconds, to its answer. Never throws for a
 * client fault; a minting failure is a 502.
 */
export async function checkIn(
  deps: CheckinDeps,
  body: unknown,
  nowMs: number,
): Promise<CheckinOutcome> {
  // The QR window is checked to the millisecond; database times are whole seconds.
  const now = Math.floor(nowMs / 1000);
  const parsed = parseRequest(body);
  if (!parsed.ok)
    return parsed.field === null
      ? refuse(400, "invalid_request", { reason: "unexpected_field" })
      : refuse(400, "invalid_request", { field: parsed.field });
  const req = parsed.req;

  const qr = verifyStationQr(req.qr, { allowlist: deps.allowlist, nowMs });
  if (!qr.ok) {
    return qr.reason === "expired"
      ? refuse(400, "station_qr_expired")
      : refuse(400, "station_qr_invalid", { reason: qr.reason });
  }
  const payload: StationPayload = qr.payload;

  if (
    deps.db
      .prepare("SELECT 1 FROM stations WHERE id = ?")
      .get(payload.station) === undefined
  ) {
    return refuse(404, "unknown_station");
  }
  const open = deps.db
    .prepare(
      "SELECT 1 FROM sessions WHERE id = ? AND starts_at <= ? AND ? < ends_at",
    )
    .get(payload.session, now, now);
  if (open === undefined) return refuse(409, "session_closed");

  const key = deps.registrations.walletKey(req.wallet);
  if (key === null || !(await walletKeyAcceptable(key)))
    return refuse(400, "invalid_request", { field: "wallet" });
  const message = checkinMessage({ ...payload, wallet: req.wallet });
  if (
    !(await walletSignatureValid(
      key,
      Buffer.from(message, "utf8"),
      req.signature,
    ))
  )
    return refuse(401, "bad_wallet_signature");

  let regHash: string;
  if (req.registrationId !== null) {
    const bound = deps.registrations.bind(req.registrationId, req.wallet, now);
    if (!bound.ok)
      return refuse(
        bound.reason === "invalid_registration_id" ? 400 : 403,
        bound.reason,
      );
    regHash = bound.regHash;
  } else {
    const existing = deps.registrations.bindingOf(req.wallet);
    if (existing === null) return refuse(403, "no_registration_binding");
    regHash = existing;
  }

  // The pass's mint address is fixed by the check-in, and recorded with it before anything is sent.
  const seed = mintSeed(deps.mintSecret, payload.session, regHash);
  const mint = mintAddressFromSeed(seed);
  let reservation: Reservation;
  try {
    const id = Number(
      deps.db
        .prepare(
          "INSERT INTO checkins (session_id, station_id, reg_hash, wallet, station_nonce, mint, mint_status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
        )
        .run(
          payload.session,
          payload.station,
          regHash,
          req.wallet,
          payload.nonce,
          mint,
          now,
        ).lastInsertRowid,
    );
    reservation = { id, station: payload.station, checkedInAt: now };
  } catch (err) {
    if (
      !/UNIQUE constraint failed: checkins\.session_id, checkins\.reg_hash/.test(
        String(err),
      )
    ) {
      throw err;
    }
    const existing = deps.db
      .prepare(
        "SELECT id, station_id, created_at, mint, mint_status FROM checkins WHERE session_id = ? AND reg_hash = ?",
      )
      .get(payload.session, regHash) as {
      id: number;
      station_id: string;
      created_at: number;
      mint: string | null;
      mint_status: string | null;
    };
    // A revoked pass stays revoked. done, or unrecorded from before migration 4 (db.ts): either
    // way nothing more is minted.
    if (existing.mint_status === "revoked") return refuse(409, "pass_revoked");
    if (existing.mint_status !== "pending")
      return refuse(409, "already_checked_in");
    // A reservation recorded under another secret names a mint this request cannot derive, so it
    // is left for a person rather than minted at a second address.
    if (existing.mint !== mint) return refuse(502, "mint_failed");
    reservation = {
      id: existing.id,
      station: existing.station_id,
      checkedInAt: existing.created_at,
      earlier: true,
    };
  }
  return completePass(deps, reservation, req.wallet, payload.session, seed);
}

/** A reserved check-in: its row, and the station and time its pass carries. */
interface Reservation {
  readonly id: number;
  readonly station: string;
  readonly checkedInAt: number;
  /** True when an earlier request made the reservation, so its mint may already be on chain. */
  readonly earlier?: boolean;
}

/**
 * Brings a pending reservation to a pass. For a reservation an earlier request made, the chain is
 * read first (passMintState): a pass the wallet holds is recorded as done without minting; a pass
 * issued at the address, an initialized Token-2022 mint, that the wallet does not hold is
 * recorded revoked and answered 409, never minted again; and any other account there, one limen
 * did not make, answers 502 mint_address_occupied and stays pending. An empty address, or one
 * that holds only lamports anyone could have sent, is minted to. Any failure leaves the
 * reservation pending, never deleted, and answers 502; the next request for this check-in reads
 * the chain again. When two requests both reach completion, only the one that moves the row from
 * pending to done answers 201.
 */
async function completePass(
  deps: CheckinDeps,
  reservation: Reservation,
  wallet: string,
  session: string,
  seed: Uint8Array,
): Promise<CheckinOutcome> {
  const mint = mintAddressFromSeed(seed);
  // Completion is one transition, pending to done. Only the request whose UPDATE changes the row
  // answers 201; another that completes the same reservation answers 409.
  const done = (signature: string | null): CheckinOutcome => {
    const { changes } = deps.db
      .prepare(
        "UPDATE checkins SET mint_status = 'done' WHERE id = ? AND mint_status = 'pending'",
      )
      .run(reservation.id);
    if (Number(changes) !== 1) return refuse(409, "already_checked_in");
    return {
      status: 201,
      body: {
        status: "checked_in",
        station: reservation.station,
        session,
        mint,
        signature,
      },
    };
  };
  try {
    if (reservation.earlier === true) {
      const state = await deps.minter.state(wallet, mint);
      if (state === "minted") return done(null);
      // An initialized Token-2022 mint at the derived address is a pass issued there, burned or
      // not, so the check-in is never retried. The wallet does not hold it, so it was revoked.
      if (state === "unheld") {
        deps.db
          .prepare(
            "UPDATE checkins SET mint_status = 'revoked' WHERE id = ? AND mint_status = 'pending'",
          )
          .run(reservation.id);
        return refuse(409, "pass_revoked");
      }
      // An account limen did not make: the row stays pending, for an operator.
      if (state === "occupied") return refuse(502, "mint_address_occupied");
    }
    const { signature } = await deps.minter.mint(wallet, seed, {
      station: reservation.station,
      session,
      checkedInAt: reservation.checkedInAt,
    });
    return done(signature);
  } catch (err) {
    if (err instanceof MintAddressOccupied)
      return refuse(502, "mint_address_occupied");
    return refuse(502, "mint_failed");
  }
}
