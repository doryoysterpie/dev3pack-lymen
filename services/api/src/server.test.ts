// E-02 done test, part 2: health returns the version.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { openDatabase } from "./db.ts";
import { API_VERSION, createApiServer } from "./server.ts";

const server = createApiServer({
  db: openDatabase(":memory:"),
  version: API_VERSION,
});
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

test("the API version is the one services/api/package.json states", () => {
  assert.equal(API_VERSION, "0.1.0");
});

test("GET /health returns 200 with the API version and the migrated schema version", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await res.json(), {
    status: "ok",
    version: "0.1.0",
    schema_version: 2,
  });
});

test("a method other than GET on /health is refused with 405 and an Allow header", async () => {
  const res = await fetch(`${base}/health`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
  assert.deepEqual(await res.json(), { error: "method_not_allowed" });
});

test("an unknown path returns 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});
