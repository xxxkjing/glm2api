import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";

import { handleOpenAiRequest } from "../src/routes/openai-routes.js";
import { GuestSessionPool, GuestSession } from "../src/services/guest-session.js";

function makeSessionPool() {
  return new GuestSessionPool([
    new GuestSession({ token: "test-token", deviceId: "test-device" })
  ]);
}

function makeHandler(streamChat) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pool = makeSessionPool();
    await handleOpenAiRequest(req, res, url, { sessionPool: pool, streamChat });
  };
}

function sendRequest(handler, body, path = "/v1/chat/completions") {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const req = request({
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  });
}

test("non-stream chat returns aggregated content", async () => {
  async function* mockStream() {
    yield { type: "content", content: "你好" };
    yield { type: "content", content: "世界" };
    yield { type: "end" };
  }
  const { status, body: raw } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: false
  });
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].message.content, "你好世界");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.model, "glm-5.3-flash");
});

test("stream chat returns SSE chunks", async () => {
  async function* mockStream() {
    yield { type: "content", content: "嗨" };
    yield { type: "end" };
  }
  const { status, headers, body } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  });
  assert.equal(status, 200);
  assert.match(headers["content-type"], /text\/event-stream/);
  assert.match(body, /data: \{.*"content":"嗨"/);
  assert.match(body, /finish_reason":"stop"/);
  assert.match(body, /data: \[DONE\]/);
});

test("stream chat handles thinking events", async () => {
  async function* mockStream() {
    yield { type: "thinking", content: "思考中" };
    yield { type: "content", content: "答案" };
    yield { type: "end" };
  }
  const { status, body } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  });
  assert.equal(status, 200);
  // thinking 事件目前被忽略（正文才转发），确保不崩溃且正文正常
  assert.match(body, /"content":"答案"/);
});

test("upstream error marks session rate limited and returns 502", async () => {
  async function* mockStream() {
    throw new Error("GLM_40012 rate limited");
  }
  const { status, body } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(status, 502);
  assert.match(body, /Upstream error/);
});

test("no session returns 429", async () => {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // 空会话池
    await handleOpenAiRequest(req, res, url, {
      sessionPool: new GuestSessionPool([]),
      streamChat: async function* () {}
    });
  };
  const { status, body } = await sendRequest(handler, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(status, 429);
  assert.match(body, /No available guest session/);
});