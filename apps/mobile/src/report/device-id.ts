// The install ID a report carries as its device_id (E-10, app side). The triage service stores
// only its hash and counts distinct IDs as independent devices (D-05). That means distinct
// install IDs, not distinct phones or people: a reinstall or a second emulator is a new ID.
//
// The ID is random, made once, and kept with expo-secure-store, in the device's key storage. It is
// the only thing this app stores there. When the store cannot be read or written, the ID lasts
// this launch only. The ID is not a secret, so Math.random is enough to keep two installs from
// sharing one.

/** The two storage calls this module uses. expo-secure-store satisfies it. */
export interface IdStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export const INSTALL_ID_KEY = "limen.install-id";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const INSTALL_ID = /^[A-Za-z0-9]{32}$/;

/** 32 characters from the alphabet, which the API's [A-Za-z0-9_-]{16,128} accepts. */
export function newDeviceId(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return id;
}

/**
 * Reads the stored install ID, or makes one and stores it. A stored value that is not an ID
 * this module made is replaced. If the store fails, the new ID is used for this launch only.
 */
export async function loadInstallId(
  store: IdStore,
  make: () => string = newDeviceId,
): Promise<string> {
  let stored: string | null;
  try {
    stored = await store.getItemAsync(INSTALL_ID_KEY);
  } catch {
    return make();
  }
  if (stored !== null && INSTALL_ID.test(stored)) return stored;
  const id = make();
  try {
    await store.setItemAsync(INSTALL_ID_KEY, id);
  } catch {
    // Not kept: this launch uses the ID, and the next launch makes another.
  }
  return id;
}

let current: Promise<string> | null = null;

/** This install's ID, read from the store once per launch. */
export function installId(store: IdStore): Promise<string> {
  current ??= loadInstallId(store);
  return current;
}
