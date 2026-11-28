// Check-in, backend half (E-05). Registration binding is E-07's (registration.ts) and pass
// minting is E-06's (mintPass on devnet, through connectDevnet). checkIn reaches them through the
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
//   limen check-in v1
//   station: <station>
//   session: <session>
//   nonce: <nonce>
//   wallet: <wallet address>
//   registration: <registration ID, or empty>
//
// The backend re-verifies in this order, and the first failure is the answer: the request's
// shape; the station QR (allowlisted signer, signature, at most 60 s old); the station, and the
// session still open; the wallet's signature over the message; the registration (the wallet's
// binding, or a first binding of registration_id); one check-in per registration per session.
// Only then does it mint.
import type { DatabaseSync } from "node:sqlite";

import type { Connection } from "@solana/web3.js";

import { devnetEndpoint } from "./devnet-endpoint.ts";
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

/** What E-05 needs from E-06 (E-06: mintPass). */
export interface PassMinter {
  mint(
    wallet: string,
    details: {
      readonly station: string;
      readonly session: string;
      readonly checkedInAt: number;
    },
  ): Promise<{ readonly mint: string; readonly signature: string }>;
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
 * E-06's pass mint on devnet, paid for and signed by the organizer key. `url` must be unset or
 * the one devnet endpoint (devnet-endpoint.ts); any other URL is refused here, when the minter is
 * built, before any connection. The connection is made at the first mint, through connectDevnet,
 * which also refuses a cluster whose genesis hash is not devnet's before anything is sent; a
 * failed connection is tried again at the next mint. E-06's code and @solana/web3.js load at that
 * first mint too, so the API starts without them where no check-in mints.
 */
export function devnetMinter(
  url: string | undefined,
  organizer: OrganizerKey,
  connect?: (url: string) => Promise<Connection>,
): PassMinter {
  const endpoint = devnetEndpoint(url);
  let ready: Promise<{
    mint: (
      wallet: string,
      details: Parameters<PassMinter["mint"]>[1],
    ) => Promise<{ mint: string; signature: string }>;
  }> | null = null;
  const prepare = async () => {
    const { Keypair, PublicKey } = await import("@solana/web3.js");
    const { connectDevnet, mintPass } = await import("./pass-mint.ts");
    const connection = await (connect ?? connectDevnet)(endpoint);
    const payer = Keypair.fromSecretKey(organizer.secretKeyBytes());
    return {
      mint: async (
        wallet: string,
        details: Parameters<PassMinter["mint"]>[1],
      ) => {
        const minted = await mintPass(
          connection,
          payer,
          new PublicKey(wallet),
          details,
        );
        return { mint: minted.mint.toBase58(), signature: minted.signature };
      },
    };
  };
  return {
    async mint(wallet, details) {
      ready ??= prepare().catch((err: unknown) => {
        ready = null;
        throw err;
      });
      return (await ready).mint(wallet, details);
    },
  };
}

export interface CheckinDeps {
  readonly db: DatabaseSync;
  /** Signer IDs allowed to sign station QRs (see stationAllowlist). */
  readonly allowlist: ReadonlySet<string>;
  readonly registrations: CheckinRegistrations;
  readonly minter: PassMinter;
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

/** The exact text the wallet signs. */
export function checkinMessage(p: {
  station: string;
  session: string;
  nonce: string;
  wallet: string;
  registrationId: string | null;
}): string {
  return [
    "limen check-in v1",
    `station: ${p.station}`,
    `session: ${p.session}`,
    `nonce: ${p.nonce}`,
    `wallet: ${p.wallet}`,
    `registration: ${p.registrationId ?? ""}`,
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
    | "mint_failed"
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
  const message = checkinMessage({
    ...payload,
    wallet: req.wallet,
    registrationId: req.registrationId,
  });
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

  let checkinId: number;
  try {
    checkinId = Number(
      deps.db
        .prepare(
          "INSERT INTO checkins (session_id, station_id, reg_hash, wallet, station_nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          payload.session,
          payload.station,
          regHash,
          req.wallet,
          payload.nonce,
          now,
        ).lastInsertRowid,
    );
  } catch (err) {
    if (
      /UNIQUE constraint failed: checkins\.session_id, checkins\.reg_hash/.test(
        String(err),
      )
    ) {
      return refuse(409, "already_checked_in");
    }
    throw err;
  }

  try {
    const minted = await deps.minter.mint(req.wallet, {
      station: payload.station,
      session: payload.session,
      checkedInAt: now,
    });
    deps.db
      .prepare("UPDATE checkins SET mint = ? WHERE id = ?")
      .run(minted.mint, checkinId);
    return {
      status: 201,
      body: {
        status: "checked_in",
        station: payload.station,
        session: payload.session,
        mint: minted.mint,
        signature: minted.signature,
      },
    };
  } catch {
    // No pass exists, so the check-in is undone and the participant can try again.
    deps.db.prepare("DELETE FROM checkins WHERE id = ?").run(checkinId);
    return refuse(502, "mint_failed");
  }
}
