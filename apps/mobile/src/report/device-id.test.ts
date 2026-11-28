// E-10, app side: the install ID is made once, stored under one key, and read back after.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INSTALL_ID_KEY,
  loadInstallId,
  newDeviceId,
  type IdStore,
} from "./device-id.ts";

const API_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;
const ID_A = "A".repeat(32);
const ID_B = "B".repeat(32);

/** An in-memory store that records every write. */
function memoryStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  const store: IdStore = {
    getItemAsync: async (key) => items.get(key) ?? null,
    setItemAsync: async (key, value) => {
      writes.push([key, value]);
      items.set(key, value);
    },
  };
  return { store, items, writes };
}

describe("install ID", () => {
  it("is 32 characters the API accepts, at both ends of the random range", () => {
    assert.equal(
      newDeviceId(() => 0),
      ID_A,
    );
    assert.equal(
      newDeviceId(() => 0.999999999),
      "9".repeat(32),
    );
    assert.match(newDeviceId(), API_FORMAT);
  });

  it("is made once and stored as the only item, then read back on the next launch", async () => {
    const { store, items, writes } = memoryStore();
    assert.equal(await loadInstallId(store, () => ID_A), ID_A);
    assert.deepEqual(writes, [[INSTALL_ID_KEY, ID_A]]);
    assert.deepEqual([...items.keys()], [INSTALL_ID_KEY]);
    // A later launch reads the stored ID and makes no new one.
    assert.equal(await loadInstallId(store, () => ID_B), ID_A);
    assert.equal(writes.length, 1);
  });

  it("replaces a stored value that is not an install ID", async () => {
    const { store, writes } = memoryStore({ [INSTALL_ID_KEY]: "not an id" });
    assert.equal(await loadInstallId(store, () => ID_B), ID_B);
    assert.deepEqual(writes, [[INSTALL_ID_KEY, ID_B]]);
  });

  it("uses a new ID for this launch when the store cannot be read or written", async () => {
    const unreadable: IdStore = {
      getItemAsync: async () => {
        throw new Error("no store");
      },
      setItemAsync: async () => {
        throw new Error("must not write");
      },
    };
    assert.equal(await loadInstallId(unreadable, () => ID_A), ID_A);
    const unwritable: IdStore = {
      getItemAsync: async () => null,
      setItemAsync: async () => {
        throw new Error("full");
      },
    };
    assert.equal(await loadInstallId(unwritable, () => ID_B), ID_B);
  });
});
