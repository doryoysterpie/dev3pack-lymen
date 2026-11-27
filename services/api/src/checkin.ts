// Check-in, backend half (E-05). Prep build: registration binding (E-07) and pass minting (E-06)
// sit behind the two interfaces below until those units land and their code is wired in.
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
import { createPublicKey, verify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { verifyStationQr, type StationPayload } from "./station-qr.ts";

/** What E-05 needs from E-07. Each method names the E-07 function that will back it. */
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
    | { readonly ok: false; readonly reason: string };
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

const REQUEST_KEYS = new Set(["qr", "wallet", "registration_id", "signature"]);
const MAX_FIELD_CHARS = 1024;
// DER header of an X.509 SubjectPublicKeyInfo Ed25519 public key (RFC 8410).
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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
): { ok: true; req: CheckinRequest } | { ok: false; field: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { ok: false, field: "body" };
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b))
    if (!REQUEST_KEYS.has(key)) return { ok: false, field: key };
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

function walletSigned(
  key: Uint8Array,
  message: string,
  signature: Buffer,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, key]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

const refuse = (
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): CheckinOutcome => ({
  status,
  body: { error, ...extra },
});

/** Runs one check-in to its answer. Never throws for a client fault; a minting failure is a 502. */
export async function checkIn(
  deps: CheckinDeps,
  body: unknown,
  now: number,
): Promise<CheckinOutcome> {
  const parsed = parseRequest(body);
  if (!parsed.ok)
    return refuse(400, "invalid_request", { field: parsed.field });
  const req = parsed.req;

  const qr = verifyStationQr(req.qr, {
    allowlist: deps.allowlist,
    nowMs: now * 1000,
  });
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
  if (key === null || key.length !== 32)
    return refuse(400, "invalid_request", { field: "wallet" });
  const message = checkinMessage({
    ...payload,
    wallet: req.wallet,
    registrationId: req.registrationId,
  });
  if (!walletSigned(key, message, req.signature))
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
