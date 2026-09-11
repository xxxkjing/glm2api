// S3 官方级加固测试：标准 OpenAI 错误结构 + usage 估算 + 模型列表
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { handleOpenAiRequest } from "../src/routes/openai-routes.js";
import { GuestSessionPool } from "../src/services/guest-session.js";

function send(handler, body, path = "/v1/chat/completions") {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const payload = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path, method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => { srv.close(); resolve({ status: res.statusCode, body: data }); });
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
  });
}

function sendGet(handler, path) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const req = request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => { srv.close(); resolve({ status: res.statusCode, body: data }); });
        }
      );
      req.on("error", reject);
      req.end();
    });
  });
}

// 测试1：无可用会话 → 429 标准 rate_limit_error 结构
test("S3: no session → 429 standard rate_limit_error body", async () => {
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: new GuestSessionPool()
  });
  const { status, body } = await send(handler, { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
  assert.equal(status, 429);
  const err = JSON.parse(body).error;
  assert.equal(err.type, "rate_limit_error", `type 应为 rate_limit_error, got: ${err.type}`);
  assert.equal(err.code, "rate_limit_exceeded", `code 应为 rate_limit_exceeded, got: ${err.code}`);
  assert.ok(err.message, "应有 message");
  console.log("✅ S3 429 标准错误结构");
});

// 测试2：usage 估算非零且 total = prompt + completion
test("S3: non-stream usage estimated (non-zero, consistent)", async () => {
  async function* mockStream() {
    yield { type: "content", content: "北京今天晴，气温 25 度。" };
    yield { type: "end" };
  }
  const pool = new GuestSessionPool();
  pool.add({ token: "t", deviceId: "d", isExpired: () => false, role: "guest" });
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: pool, streamChat: () => mockStream()
  });
  const { body } = await send(handler, {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "北京天气怎么样？今天适合出行吗？" }]
  });
  const usage = JSON.parse(body).usage;
  assert.ok(usage.prompt_tokens > 0, `prompt_tokens 应 > 0, got: ${usage.prompt_tokens}`);
  assert.ok(usage.completion_tokens > 0, `completion_tokens 应 > 0, got: ${usage.completion_tokens}`);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  console.log("✅ S3 usage 估算");
});

// 测试3：/v1/models 标准 OpenAI 列表格式
test("S3: /v1/models returns standard OpenAI list format", async () => {
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: new GuestSessionPool()
  });
  const { status, body } = await sendGet(handler, "/v1/models");
  assert.equal(status, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.object, "list");
  assert.ok(Array.isArray(parsed.data) && parsed.data.length > 0);
  for (const m of parsed.data) {
    assert.equal(m.object, "model");
    assert.ok(typeof m.id === "string" && m.id.length > 0);
    assert.ok(typeof m.owned_by === "string");
    assert.ok(typeof m.created === "number");
  }
  console.log("✅ S3 模型列表");
});
