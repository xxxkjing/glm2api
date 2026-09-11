// 模拟 opencode 客户端的工具调用测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";
import { handleOpenAiRequest } from "../src/routes/openai-routes.js";
import { GuestSessionPool, GuestSession } from "../src/services/guest-session.js";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "搜索网页获取信息",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          max_results: { type: "integer", description: "最大结果数" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "执行数学计算",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "数学表达式" }
        },
        required: ["expression"]
      }
    }
  }
];

function makePool() {
  return new GuestSessionPool([new GuestSession({ token: "t", deviceId: "d" })]);
}

function send(handler, body) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const payload = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => { srv.close(); resolve({ status: res.statusCode, headers: res.headers, body: data }); });
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
  });
}

// 测试1：非流式 — 模型输出工具调用 XML → OpenAI tool_calls 格式
test("non-stream: model outputs <tool> XML → proper tool_calls response", async () => {
  async function* mockStream() {
    yield { type: "content", content: '根据用户需求，我需要调用搜索工具来获取最新信息。\n\n<tool name="search_web">{"query":"GLM AI 最新进展","max_results":5}</tool>' };
    yield { type: "end" };
  }
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: makePool(), streamChat: () => mockStream()
  });
  const { status, body: raw } = await send(handler, {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "查一下 GLM AI 最新进展" }],
    stream: false,
    tools: TOOLS
  });
  assert.equal(status, 200, `非流式工具调用失败: ${raw}`);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].finish_reason, "tool_calls", `finish_reason 应为 tool_calls, got: ${body.choices[0].finish_reason}`);
  assert.ok(Array.isArray(body.choices[0].message.tool_calls), "应有 tool_calls 数组");
  const tc = body.choices[0].message.tool_calls[0];
  assert.equal(tc.type, "function");
  assert.equal(tc.function.name, "search_web");
  // arguments 必须是合法 JSON
  const args = JSON.parse(tc.function.arguments);
  assert.equal(args.query, "GLM AI 最新进展");
  assert.equal(args.max_results, 5);
  console.log("✅ 非流式工具调用正确");
});

// 测试2：流式 — delta 中正确携带 tool_calls 增量
test("stream: delta carries tool_calls with proper OpenAI format", async () => {
  async function* mockStream() {
    yield { type: "content", content: '<tool name="search_web">{"query":"' };
    yield { type: "content", content: 'GLM AI","max_results":3}</tool>' };
    yield { type: "end" };
  }
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: makePool(), streamChat: () => mockStream()
  });
  const { status, body } = await send(handler, {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "查 GLM" }],
    stream: true,
    tools: TOOLS
  });
  assert.equal(status, 200);
  // 流式响应应包含 tool_calls 相关字段
  assert.match(body, /"tool_calls"/, "SSE 应包含 tool_calls");
  assert.match(body, /"search_web"/, "SSE 应包含工具名");
  assert.match(body, /finish_reason":"tool_calls"/, "SSE 应以 tool_calls finish_reason 结束");
  console.log("✅ 流式工具调用正确");
});

// 测试3：多工具调用
test("non-stream: multiple tool calls in one response", async () => {
  async function* mockStream() {
    yield { type: "content", content: '<tool name="search_web">{"query":"天气"}</tool>\n<tool name="calculate">{"expression":"2+2"}</tool>' };
    yield { type: "end" };
  }
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: makePool(), streamChat: () => mockStream()
  });
  const { status, body: raw } = await send(handler, {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "查天气并算2+2" }],
    stream: false,
    tools: TOOLS
  });
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls.length, 2, `应解析出 2 个工具调用，got: ${body.choices[0].message.tool_calls.length}`);
  console.log("✅ 多工具调用正确");
});

// 测试4：无工具时仍返回 content（向后兼容）
test("non-stream: no tools → returns content (backward compat)", async () => {
  async function* mockStream() {
    yield { type: "content", content: "北京今天晴，气温 25 度。" };
    yield { type: "end" };
  }
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: makePool(), streamChat: () => mockStream()
  });
  const { status, body: raw } = await send(handler, {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "北京天气" }],
    stream: false
  });
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.choices[0].message.content, "北京今天晴，气温 25 度。");
  assert.ok(!body.choices[0].message.tool_calls, "无工具时应无 tool_calls 字段");
  console.log("✅ 向后兼容正确");
});

// 测试5：tool_choice=required，模型输出工具调用 → 正确返回
test("tool_choice=required: model outputs tool call → proper response", async () => {
  async function* mockStream() {
    yield { type: "content", content: '<tool name="calculate">{"expression":"100*0.15"}</tool>' };
    yield { type: "end" };
  }
  const handler = (req, res) => handleOpenAiRequest(req, res, new URL(req.url, "http://x"), {
    sessionPool: makePool(), streamChat: () => mockStream()
  });
  const { status, body: raw } = await send(handler, {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "100 的 15% 是多少" }],
    stream: false,
    tools: TOOLS,
    tool_choice: "required"
  });
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "calculate");
  console.log("✅ tool_choice=required 正确");
});
