import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";

import { handleOpenAiRequest } from "../src/routes/openai-routes.js";
import { GuestSessionPool, GuestSession } from "../src/services/guest-session.js";

function makePool() {
  const pool = new GuestSessionPool([
    new GuestSession({ token: "t1", deviceId: "d1111111" }),
    new GuestSession({ token: "t2", deviceId: "d2222222" })
  ]);
  pool.markRateLimited("t2", 60_000);
  return pool;
}

function get(path) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      await handleOpenAiRequest(req, res, url, { sessionPool: makePool() });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      });
      req.on("error", reject);
      req.end();
    });
  });
}

test("GET /admin returns HTML status page", async () => {
  const { status, headers, body } = await get("/admin");
  assert.equal(status, 200);
  assert.match(headers["content-type"], /text\/html/);
  assert.match(body, /glm2api 管理/);
  assert.match(body, /会话总数/);
});

test("GET /admin/api/status returns session pool info", async () => {
  const { status, body: raw } = await get("/admin/api/status");
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.sessionCount, 2);
  assert.equal(body.availableSessions, 1); // t2 冷却中
  assert.equal(body.coolingSessions, 1);
  assert.ok(Array.isArray(body.models));
  assert.ok(body.sessions.length === 2);
  // t2 标记为冷却
  const t2 = body.sessions.find((s) => s.deviceId === "d2222222");
  assert.equal(t2.cooling, true);
});