// The device ID a report carries (E-10, app side). The triage service stores only its hash
// and counts distinct IDs as independent devices (D-05).
//
// This build has no storage package, so the ID is made once per app launch and is lost when
// the app closes: a reporter who restarts the app counts as a new device. A stable ID per
// install needs a storage package, which waits on the PM. The ID is not a secret, so
// Math.random is enough to keep two launches from sharing one.

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 32 characters from the alphabet, which the API's [A-Za-z0-9_-]{16,128} accepts. */
export function newDeviceId(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return id;
}

let current: string | null = null;

/** This launch's device ID, made on first use. */
export function deviceId(): string {
  current ??= newDeviceId();
  return current;
}
