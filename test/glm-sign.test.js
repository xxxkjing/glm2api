import { test } from "node:test";
import assert from "node:assert/strict";

import { createSignature, md5, SIGN_SECRET, buildSignedHeaders } from "../src/services/glm-sign.js";

test("md5 produces expected digest", () => {
  assert.equal(
    md5("1789000907548-b4429173741441ea83a77ee6c685831a-8a1317a7468aa3ad86e997d08f3f31cb"),
    "385a39b622afd7e6b71f46fc6cb6efe5"
  );
});

test("createSignature returns timestamp/nonce/sign with correct lengths", () => {
  const sig = createSignature("test-device");
  assert.equal(String(sig.timestamp).length, 13);
  assert.equal(sig.nonce.length, 32);
  assert.equal(sig.sign.length, 32);
});

test("buildSignedHeaders includes all required headers", () => {
  const headers = buildSignedHeaders({
    token: "jwt-token",
    deviceId: "device-123"
  });
  assert.equal(headers["authorization"], "Bearer jwt-token");
  assert.equal(headers["app-name"], "chatglm");
  assert.equal(headers["x-device-id"], "device-123");
  assert.equal(headers["x-sign"].length, 32);
  assert.equal(headers["x-nonce"].length, 32);
  assert.equal(headers["x-timestamp"].length, 13);
  assert.equal(headers["accept"], "text/event-stream");
  assert.equal(headers["content-type"], "application/json");
});

test("buildSignedHeaders without token omits authorization", () => {
  const headers = buildSignedHeaders({ deviceId: "device-123" });
  assert.equal(headers["authorization"], undefined);
});
