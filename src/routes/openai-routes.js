// OpenAI 兼容路由：/v1/models + /v1/chat/completions
import { config } from "../config.js";
import { streamChat as defaultStreamChat } from "../services/glm-chat.js";
import { GuestSessionPool } from "../services/guest-session.js";

export async function handleOpenAiRequest(request, response, url, {
  sessionPool,
  streamChat = defaultStreamChat
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

  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    const body = await readJsonBody(request);
    await handleChatCompletion(request, response, body, { sessionPool, streamChat });
    return true;
  }

  return false;
}

async function handleChatCompletion(request, response, body, { sessionPool, streamChat }) {
  const model = body.model ?? config.defaultModel;
  const messages = body.messages ?? [];
  const stream = body.stream === true;
  const conversationId = body.conversation_id ?? makeConversationId();

  const session = sessionPool.take();
  if (!session) {
    return sendError(response, 429, "No available guest session (rate limited or expired)");
  }

  try {
    const events = streamChat({
      token: session.token,
      deviceId: session.deviceId,
      conversationId,
      messages,
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
      for await (const ev of events) {
        if (ev.type === "content") {
          writeSse(response, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }]
          });
        } else if (ev.type === "end") {
          writeSse(response, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
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
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: makeId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: fullContent },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }));
  } catch (error) {
    sessionPool.markRateLimited(session.token);
    sendError(response, 502, `Upstream error: ${error.message}`);
  }
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

function sendError(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function makeId() {
  return `chatcmpl-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function makeConversationId() {
  // 25 位 hex：13 位时间戳 + 12 位随机
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
}
