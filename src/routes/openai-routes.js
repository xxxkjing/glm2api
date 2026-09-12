// OpenAI 兼容路由：/v1/models + /v1/chat/completions
import { config } from "../config.js";
import { streamChat as defaultStreamChat } from "../services/glm-chat.js";
import { GuestSessionPool } from "../services/guest-session.js";
import { createToolSieve, extractToolAwareOutput, splitToolAwareEvents } from "../services/tool-sieve.js";
import { buildPromptWithTools, normalizeMessagesForGlM } from "../services/tool-prompt.js";

// 请求统计（内存）
const stats = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  rateLimitedRequests: 0,
  byModel: new Map(),
  startedAt: Date.now()
};

function recordRequest({ model, success, rateLimited = false }) {
  stats.totalRequests += 1;
  if (success) {
    stats.successRequests += 1;
  } else {
    stats.failedRequests += 1;
  }
  if (rateLimited) {
    stats.rateLimitedRequests += 1;
  }
  const key = model ?? "unknown";
  const entry = stats.byModel.get(key) ?? { requests: 0, success: 0 };
  entry.requests += 1;
  if (success) {
    entry.success += 1;
  }
  stats.byModel.set(key, entry);
}

export async function handleOpenAiRequest(request, response, url, {
  sessionPool,
  streamChat = defaultStreamChat,
  browserChat = null
}) {
  if (url.pathname === "/v1/models" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: config.models.map((m) => ({
        id: m.id,
        object: "model",
        created: 1720000000,
        owned_by: m.ownedBy
      }))
    }));
    return true;
  }

  if (url.pathname === "/admin" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderAdminPage(sessionPool));
    return true;
  }

  if (url.pathname === "/admin/api/status" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(buildStatusPayload(sessionPool)));
    return true;
  }

  if (url.pathname === "/admin/api/sessions" && request.method === "POST") {
    // 导入访客会话
    const body = await readJsonBody(request);
    const token = body?.token;
    if (!token || !String(token).startsWith("eyJ")) {
      return sendError(response, 400, "Invalid token (must be a JWT starting with eyJ)");
    }
    if (sessionPool.sessions.some((s) => s.token === token)) {
      return sendError(response, 409, "Session already exists");
    }
    const { GuestSession } = await import("../services/guest-session.js");
    sessionPool.add(new GuestSession({ token }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, sessionCount: sessionPool.size }));
    return true;
  }

  if (url.pathname.startsWith("/admin/api/sessions/") && request.method === "DELETE") {
    // 删除会话（按 deviceId 前缀）
    const devicePrefix = url.pathname.split("/").pop();
    const before = sessionPool.size;
    sessionPool.sessions = sessionPool.sessions.filter(
      (s) => !s.deviceId?.startsWith(devicePrefix)
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, removed: before - sessionPool.size }));
    return true;
  }

  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    const body = await readJsonBody(request);
    await handleChatCompletion(request, response, body, { sessionPool, streamChat, browserChat });
    return true;
  }

  return false;
}

function buildStatusPayload(sessionPool) {
  const now = Date.now();
  const sessions = sessionPool.sessions.map((s) => {
    const until = sessionPool.cooling.get(s.token);
    const cooling = until !== undefined && until > now;
    return {
      deviceId: s.deviceId?.slice(0, 8),
      role: s.role,
      expiresAt: s.expiresAt,
      expired: s.isExpired(now),
      cooling,
      coolingUntil: cooling ? sessionPool.cooling.get(s.token) : null
    };
  });
  return {
    sessionCount: sessionPool.size,
    availableSessions: sessionPool.availableSize(now),
    coolingSessions: Array.from(sessionPool.cooling.keys()).length,
    models: config.models.map((m) => m.id),
    defaultModel: config.defaultModel,
    apiKeyEnabled: Boolean(config.apiKey),
    stats: buildStatsPayload(),
    config: {
      port: config.port,
      dataFile: config.dataFile,
      modelCount: config.models.length
    },
    sessions
  };
}

function renderAdminPage(sessionPool) {
  const status = buildStatusPayload(sessionPool);
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>glm2api · 管理</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 720px; padding: 0 1rem; background: #111; color: #eee; }
    h1 { font-size: 1.5rem; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
    .stat { background: #222; border-radius: 6px; padding: 10px; }
    .stat b { display: block; font-size: 1.4rem; }
    .stat span { color: #999; font-size: 0.8rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    td, th { padding: 6px 8px; border-bottom: 1px solid #333; text-align: left; }
    .ok { color: #4caf50; } .warn { color: #ff9800; } .bad { color: #f44336; }
    code { background: #222; padding: 2px 6px; border-radius: 4px; }
    button { background: #333; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
    button:hover { background: #444; }
    input[type=text] { background: #222; color: #eee; border: 1px solid #444; border-radius: 6px; padding: 8px; width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; }
    .row { display: flex; gap: 8px; margin-top: 8px; }
    .msg { font-size: 0.85rem; margin-top: 8px; min-height: 1em; }
  </style>
</head>
<body>
  <h1>glm2api 管理</h1>
  <div class="card">
    <div class="grid">
      <div class="stat"><b>${status.sessionCount}</b><span>会话总数</span></div>
      <div class="stat"><b class="${status.availableSessions > 0 ? 'ok' : 'warn'}">${status.availableSessions}</b><span>可用会话</span></div>
      <div class="stat"><b>${status.coolingSessions}</b><span>冷却中</span></div>
      <div class="stat"><b>${status.models.length}</b><span>模型数</span></div>
    </div>
    <p style="margin-top:12px">
      默认模型 <code>${status.defaultModel}</code> · API Key ${status.apiKeyEnabled ? '已启用' : '未启用（开放）'}
    </p>
  </div>
  <div class="card">
    <h3>使用统计</h3>
    <div class="grid">
      <div class="stat"><b>${status.stats.totalRequests}</b><span>总请求</span></div>
      <div class="stat"><b class="ok">${status.stats.successRequests}</b><span>成功</span></div>
      <div class="stat"><b class="${status.stats.failedRequests ? 'bad' : ''}">${status.stats.failedRequests}</b><span>失败</span></div>
      <div class="stat"><b class="${status.stats.rateLimitedRequests ? 'warn' : ''}">${status.stats.rateLimitedRequests}</b><span>限流</span></div>
    </div>
    ${status.stats.byModel.length ? `<p style="margin-top:10px;font-size:0.85rem">${status.stats.byModel.map((m) => `${m.model}: ${m.requests} 次（成功 ${m.success}）`).join(' · ')}</p>` : '<p style="margin-top:10px;font-size:0.85rem;color:#999">暂无请求 — 调用 /v1/chat/completions 后显示</p>'}
    <p style="font-size:0.8rem;color:#666">运行 ${Math.floor(status.stats.uptimeSeconds / 60)} 分钟</p>
  </div>
  <div class="card">
    <h3>配置</h3>
    <table>
      <tr><td>端口</td><td><code>${status.config.port}</code></td></tr>
      <tr><td>默认模型</td><td><code>${status.defaultModel}</code></td></tr>
      <tr><td>模型数</td><td>${status.config.modelCount}</td></tr>
      <tr><td>API Key</td><td>${status.apiKeyEnabled ? '已启用（要求 Bearer 鉴权）' : '未启用（开放）'}</td></tr>
      <tr><td>会话数据文件</td><td><code>${status.config.dataFile}</code></td></tr>
      <tr><td>上游通道</td><td>chatglm.cn 匿名访客（国内站，无 captcha，IP 限流）</td></tr>
    </table>
  </div>
  <div class="card">
    <h3>导入会话</h3>
    <input id="token-input" type="text" placeholder="粘贴 chatglm_token（eyJ...）">
    <div class="row">
      <button onclick="importSession()">导入</button>
      <span class="msg" id="import-msg"></span>
    </div>
  </div>
  <div class="card">
    <h3>会话池</h3>
    <table id="session-table">
      <tr><th>设备</th><th>角色</th><th>状态</th><th>过期</th><th></th></tr>
      ${status.sessions.length ? status.sessions.map((s) => `
        <tr>
          <td><code>${s.deviceId}…</code></td>
          <td>${s.role}</td>
          <td class="${s.cooling ? 'bad' : s.expired ? 'warn' : 'ok'}">${s.cooling ? '冷却中' : s.expired ? '已过期' : '可用'}</td>
          <td>${new Date(s.expiresAt).toLocaleString()}</td>
          <td><button onclick="removeSession('${s.deviceId}')">删除</button></td>
        </tr>`).join('') : '<tr><td colspan="5">暂无会话 — 上面导入</td></tr>'}
    </table>
  </div>
  <script>
    async function importSession() {
      const input = document.getElementById('token-input');
      const msg = document.getElementById('import-msg');
      if (!input.value.trim()) { msg.textContent = '请输入 token'; return; }
      try {
        const res = await fetch('/admin/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: input.value.trim() })
        });
        const data = await res.json();
        if (res.ok) { msg.textContent = '✅ 导入成功，共 ' + data.sessionCount + ' 个会话'; input.value = ''; }
        else { msg.textContent = '❌ ' + (data.error?.message || '导入失败'); }
        setTimeout(() => location.reload(), 600);
      } catch (e) { msg.textContent = '❌ ' + e; }
    }
    async function removeSession(deviceId) {
      if (!confirm('删除该会话？')) return;
      await fetch('/admin/api/sessions/' + deviceId, { method: 'DELETE' });
      location.reload();
    }
  </script>
</body>
</html>`;
}

async function handleChatCompletion(request, response, body, { sessionPool, streamChat, browserChat }) {
  const model = body.model ?? config.defaultModel;
  const messages = body.messages ?? [];
  const stream = body.stream === true;
  const conversationId = body.conversation_id ?? makeConversationId();

  // 工具调用：构建带工具 prompt 的 messages
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { messages: promptMessages, policy } = hasTools
    ? buildPromptWithTools({ messages, toolChoice: body.tool_choice, tools: body.tools })
    : { messages: messages, policy: { allowedToolNames: [], mode: "none" } };
  const toolNames = policy.allowedToolNames;

  // 浏览器模式（方案 C）：不依赖会话池，直接经浏览器页面对话
  if (browserChat) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string"
      ? lastUser.content
      : (Array.isArray(lastUser?.content) ? lastUser.content.map((b) => b.text ?? "").join("") : "");
    // 浏览器模式：页面是纯文本界面，看不到 OpenAI 的 tools 参数；
    // 有工具时把工具提示词（首个 system 消息）拼进文本，让页面模型输出 <tool> 标签
    let text = userText;
    if (hasTools && promptMessages[0]?.role === "system") {
      const toolPromptText = promptMessages[0].content?.[0]?.text ?? "";
      if (toolPromptText) text = `${toolPromptText}\n\n用户问题：${userText}`;
    }
    const events = browserChat({ text, signal: request.signal });
    if (stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const completionId = makeId();
      writeSse(response, {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      });
      const sieve = hasTools ? createToolSieve(toolNames) : null;
      let hasToolCalls = false;
      for await (const ev of events) {
        if (ev.type === "content") {
          if (sieve) {
            hasToolCalls = writeSieveEvents(response, completionId, model, sieve.push(ev.content), hasToolCalls);
          } else {
            writeSse(response, {
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }]
            });
          }
        } else if (ev.type === "end") {
          if (sieve) {
            hasToolCalls = writeSieveEvents(response, completionId, model, sieve.flush(), hasToolCalls);
          }
          writeSse(response, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? "tool_calls" : "stop" }]
          });
          response.end("data: [DONE]\n\n");
          return;
        } else if (ev.type === "error") {
          sendError(response, 502, `Upstream error: ${ev.error.message}`);
          return;
        }
      }
      if (sieve) {
        hasToolCalls = writeSieveEvents(response, completionId, model, sieve.flush(), hasToolCalls);
      }
      writeSse(response, {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? "tool_calls" : "stop" }]
      });
      response.end("data: [DONE]\n\n");
      return;
    }
    // 非流式聚合
    let fullContent = "";
    for await (const ev of events) {
      if (ev.type === "content") fullContent += ev.content;
      if (ev.type === "error") {
        return sendError(response, 502, `Upstream error: ${ev.error.message}`);
      }
    }
    // 工具调用解析（浏览器模式同样支持 <tool> XML → tool_calls）
    const { content: cleanContent, toolCalls } = hasTools
      ? extractToolAwareOutput(fullContent, toolNames)
      : { content: fullContent, toolCalls: [] };
    const hasToolCalls = toolCalls.length > 0;
    // 有 tool_calls 时按 OpenAI 规范 content 置 null（避免 tag 外杂音文本干扰客户端）
    const message = hasToolCalls
      ? { role: "assistant", content: null, tool_calls: toolCalls }
      : { role: "assistant", content: cleanContent };
    recordRequest({ model, success: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: makeId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: hasToolCalls ? "tool_calls" : "stop" }],
      usage: buildUsage(messages, fullContent)
    }));
    return;
  }

  const session = sessionPool.take();
  if (!session) {
    recordRequest({ model, success: false, rateLimited: true });
    return sendError(response, 429, "No available guest session (rate limited or expired)");
  }

  try {
    const events = streamChat({
      token: session.token,
      deviceId: session.deviceId,
      conversationId,
      messages: normalizeMessagesForGlM(promptMessages, toolNames),
      model,
      signal: request.signal
    });

    if (stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const completionId = makeId();
      writeSse(response, {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      });
      const sieve = hasTools ? createToolSieve(toolNames) : null;
      let hasToolCalls = false;
      for await (const ev of events) {
        if (ev.type === "content") {
          if (sieve) {
            hasToolCalls = writeSieveEvents(response, completionId, model, sieve.push(ev.content), hasToolCalls);
          } else {
            writeSse(response, {
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }]
            });
          }
        } else if (ev.type === "end") {
          if (sieve) {
            hasToolCalls = writeSieveEvents(response, completionId, model, sieve.flush(), hasToolCalls);
          }
          writeSse(response, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? "tool_calls" : "stop" }]
          });
          response.end("data: [DONE]\n\n");
          return;
        } else if (ev.type === "error") {
          writeSse(response, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          });
          response.end("data: [DONE]\n\n");
          return;
        }
      }
      if (sieve) {
        hasToolCalls = writeSieveEvents(response, completionId, model, sieve.flush(), hasToolCalls);
      }
      writeSse(response, {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? "tool_calls" : "stop" }]
      });
      response.end("data: [DONE]\n\n");
      return;
    }

    // 非流式：聚合
    let fullContent = "";
    for await (const ev of events) {
      if (ev.type === "content") {
        fullContent += ev.content;
      }
    }
    // 工具调用解析（<tool> XML → OpenAI tool_calls）
    const { content: cleanContent, toolCalls } = extractToolAwareOutput(fullContent, toolNames);
    const hasToolCalls = toolCalls.length > 0;
    const message = hasToolCalls
      ? { role: "assistant", content: cleanContent || null, tool_calls: toolCalls }
      : { role: "assistant", content: cleanContent };
    recordRequest({ model, success: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: makeId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: hasToolCalls ? "tool_calls" : "stop"
      }],
        usage: buildUsage(messages, cleanContent)
    }));
  } catch (error) {
    sessionPool.markRateLimited(session.token);
    recordRequest({ model, success: false });
    sendError(response, 502, `Upstream error: ${error.message}`);
  }
}

/**
 * 把 tool-sieve 产出的事件（text / tool_calls）写成 OpenAI 流式 SSE。
 * @returns {boolean} 是否产生过 tool_calls
 */
function writeSieveEvents(response, completionId, model, events, hasToolCalls) {
  let called = hasToolCalls;
  for (const se of events) {
    if (se.type === "text") {
      writeSse(response, {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: se.text }, finish_reason: null }]
      });
    } else if (se.type === "tool_calls") {
      called = true;
      const toolCalls = (se.calls ?? []).map((c, i) => ({
        index: i,
        id: c.id,
        type: c.type,
        function: c.function
      }));
      writeSse(response, {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]
      });
    }
  }
  return called;
}

function buildStatsPayload() {
  return {
    totalRequests: stats.totalRequests,
    successRequests: stats.successRequests,
    failedRequests: stats.failedRequests,
    rateLimitedRequests: stats.rateLimitedRequests,
    byModel: Array.from(stats.byModel.entries()).map(([model, s]) => ({ model, ...s })),
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000)
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        request.destroy();
        reject(new Error("body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendError(response, status, message, extra = {}) {
  // OpenAI 标准错误结构：{ error: { message, type, code, param? } }
  const TYPES = {
    400: "invalid_request_error",
    401: "invalid_request_error",
    404: "invalid_request_error",
    409: "invalid_request_error",
    429: "rate_limit_error",
    500: "server_error",
    502: "server_error",
    503: "server_error"
  };
  const CODES = {
    400: "invalid_request",
    401: "invalid_api_key",
    404: "model_not_found",
    409: "conflict",
    429: "rate_limit_exceeded",
    500: "internal_error",
    502: "upstream_error",
    503: "service_unavailable"
  };
  const headers = { "content-type": "application/json" };
  // 限流友好：429 带 Retry-After（冷却窗口参考，客户端可据此退避）
  if (status === 429) headers["retry-after"] = String(extra.retryAfter ?? 30);
  response.writeHead(status, headers);
  response.end(JSON.stringify({
    error: {
      message,
      type: extra.type ?? TYPES[status] ?? "invalid_request_error",
      code: extra.code ?? CODES[status] ?? "invalid_request",
      ...(extra.param ? { param: extra.param } : {})
    }
  }));
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function makeId() {
  return `chatcmpl-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** 粗略 token 估算（无真实上游 usage 时的降级）：~4 字符 ≈ 1 token（中英混合经验值） */
function estimateTokens(text) {
  return Math.ceil((String(text ?? "").length) / 4);
}

/** 构造 usage（prompt = 请求消息文本估算；completion = 返回内容估算） */
function buildUsage(messages, content) {
  const prompt = Array.isArray(messages)
    ? messages.map((m) => {
      if (typeof m?.content === "string") return m.content;
      if (Array.isArray(m?.content)) return m.content.map((b) => b?.text ?? b?.content ?? "").join("");
      return "";
    }).join("\n")
    : "";
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(content);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function makeConversationId() {
  // 25 位 hex：13 位时间戳 hex + 12 位随机（对齐上游格式 6aa33e6df49fe6bb2f286f02）
  const ts = Date.now().toString(16).padStart(13, "0").slice(0, 13);
  return `${ts}${Math.random().toString(16).slice(2, 14)}`.slice(0, 25);
}
