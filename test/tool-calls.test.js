// 伪 FC 端到端测试：验证 /v1/chat/completions 在 tools 场景下的行为
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";

import { handleOpenAiRequest } from "../src/routes/openai-routes.js";
import { GuestSessionPool, GuestSession } from "../src/services/guest-session.js";

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "查询指定城市的天气",
    parameters: { type: "object", properties: { city: { type: "string" } } }
  }
};

function makeSessionPool() {
  return new GuestSessionPool([new GuestSession({ token: "test-token", deviceId: "test-device" })]);
}

function makeHandler(streamChat) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await handleOpenAiRequest(req, res, url, { sessionPool: makeSessionPool(), streamChat });
  };
}

function sendRequest(handler, body, path = "/v1/chat/completions") {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const req = request({
        hostname: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, headers: res.headers, body: data }); });
      });
      req.on("error", reject);
      req.end(payload);
    });
  });
}

test("non-stream with tools returns tool_calls when model emits XML", async () => {
  async function* mockStream() {
    yield { type: "content", content: '<tool name="get_weather">{"city":"北京"}</tool>' };
    yield { type: "end" };
  }
  const { status, body: raw } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "北京天气" }],
    stream: false,
    tools: [WEATHER_TOOL]
  });
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.ok(Array.isArray(body.choices[0].message.tool_calls));
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "get_weather");
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"city":"北京"}');
});

test("stream with tools emits tool_calls chunks", async () => {
  async function* mockStream() {
    yield { type: "content", content: '<tool name="get_weather">{"city":"北京"}</tool>' };
    yield { type: "end" };
  }
  const { status, body } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "北京天气" }],
    stream: true,
    tools: [WEATHER_TOOL]
  });
  assert.equal(status, 200);
  assert.match(body, /"tool_calls"/);
  assert.match(body, /"get_weather"/);
  assert.match(body, /finish_reason":"tool_calls"/);
  assert.match(body, /data: \[DONE\]/);
});

test("no tools still returns text (backward compat)", async () => {
  async function* mockStream() {
    yield { type: "content", content: "北京今天晴，-3度" };
    yield { type: "end" };
  }
  const { status, body: raw } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "北京天气" }],
    stream: false
  });
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.choices[0].message.content, "北京今天晴，-3度");
});

test("tool_choice=required degrades gracefully when model ignores tools", async () => {
  async function* mockStream() {
    yield { type: "content", content: "直接回答" };
    yield { type: "end" };
  }
  const { status, body: raw } = await sendRequest(makeHandler(() => mockStream()), {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "北京天气" }],
    stream: false,
    tools: [WEATHER_TOOL],
    tool_choice: "required"
  });
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].finish_reason, "stop");
});
