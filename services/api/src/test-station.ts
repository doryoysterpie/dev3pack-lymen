// Station QR settings for tests whose servers do not fetch a station QR (E-03).
import { createPrivateKey } from "node:crypto";

import type { StationSigner } from "./station-qr.ts";

// RFC 8032 section 7.1, TEST 1: a published Ed25519 test vector, not a real key.
const SIGNER: StationSigner = {
  publicKey: Buffer.from(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
  privateKey: createPrivateKey({
    key: Buffer.from(
      "302e020100300506032b657004220420" +
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  }),
};

/** A test value of the display secret, at least 32 characters, as the API requires. */
export const TEST_STATION_DISPLAY_SECRET =
  "test-display-token-0123456789abcdef";

export const TEST_STATION_SETTINGS = {
  stationSigner: SIGNER,
  stationDisplayToken: TEST_STATION_DISPLAY_SECRET,
  now: (): number => 1_795_000_000,
} as const;
