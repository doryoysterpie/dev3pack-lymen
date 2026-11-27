// E-10, app side: the device ID fits the API's format and holds for one launch.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deviceId, newDeviceId } from "./device-id.ts";

const API_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

describe("device ID", () => {
  it("is 32 characters the API accepts, at both ends of the random range", () => {
    assert.equal(
      newDeviceId(() => 0),
      "A".repeat(32),
    );
    assert.equal(
      newDeviceId(() => 0.999999999),
      "9".repeat(32),
    );
    assert.match(newDeviceId(), API_FORMAT);
  });

  it("stays the same for the whole launch", () => {
    assert.match(deviceId(), API_FORMAT);
    assert.equal(deviceId(), deviceId());
  });
});
