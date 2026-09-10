import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server;
let base;
let port;

before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "glm2api-test-"));
  writeFileSync(join(tmp, "sessions.json"), JSON.stringify({ sessions: [] }));
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: "3199", GLM2API_KEY: "test-key", GLM2API_DATA_FILE: join(tmp, "sessions.json") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  port = 3199;
  base = `http://127.0.0.1:${port}`;
  // 等就绪
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetchJson("/v1/models", "test-key");
      if (res) break;
    } catch {}
  }
});

after(() => {
  server?.kill();
});

function fetchJson(path, key) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, {
      method: "GET",
      headers: key ? { authorization: `Bearer ${key}` } : {}
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET /v1/models returns model list with valid key", async () => {
  const { status, body } = await fetchJson("/v1/models", "test-key");
  assert.equal(status, 200);
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m) => m.id === "glm-5.3-flash"));
});

test("GET /v1/models rejects invalid key", async () => {
  const { status } = await fetchJson("/v1/models", "wrong-key");
  assert.equal(status, 401);
});

test("GET /v1/models rejects missing key", async () => {
  const { status } = await fetchJson("/v1/models", null);
  assert.equal(status, 401);
});

test("unknown route returns 404", async () => {
  const { status } = await fetchJson("/v1/does-not-exist", "test-key");
  assert.equal(status, 404);
});