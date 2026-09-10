// 对话客户端（chatglm.cn assistant/stream 协议）
// 上游调用 + SSE 事件流解析 → OpenAI 兼容 delta 事件
import { request } from "node:https";
import { buildSignedHeaders } from "./glm-sign.js";

export const ASSISTANT_ID = "65940acff94777010aa6b796";
export const DEFAULT_MODEL = "glm-5.3-flash";
export const STREAM_URL = "/chatglm/backend-api/assistant/stream";

/**
 * 解析 SSE 字节流为事件（通用解析器）
 * @param {AsyncIterable<Buffer>} stream 响应流
 * @yields {{event: string, data: string}}
 */
export async function* parseSseStream(stream) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    // 按空行切分 SSE 事件
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = { event: "message", data: "" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
          event.event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          event.data = line.slice(5).trim();
        }
      }
      if (event.data || event.event !== "message") {
        yield event;
      }
    }
  }
  // 尾部残余
  if (buffer.trim()) {
    const raw = buffer;
    const event = { event: "message", data: "" };
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) {
        event.data = line.slice(5).trim();
      }
    }
    if (event.data) {
      yield event;
    }
  }
}

/**
 * 从 SSE 事件提取内容分片（GLM parts 结构 + 思考内容）
 * @param {object} payload 事件 JSON
 * @returns {{content: string, thinking: string, isEnd: boolean}}
 */
export function extractDelta(payload) {
  if (!payload || typeof payload !== "object") {
    return { content: "", thinking: "", isEnd: false };
  }
  // 结束标记
  if (payload.status === "finish" || payload.end === true) {
    return { content: "", thinking: "", isEnd: true };
  }
  // parts 数组：取 role=assistant 的 content（正文）和 thinking_content（思考）
  let content = "";
  let thinking = "";
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part?.role !== "assistant") {
        continue;
      }
      // 思考内容（字段兼容 thinking_content / thinking / reasoning_content）
      const thinkRaw = part.thinking_content ?? part.thinking ?? part.reasoning_content;
      if (typeof thinkRaw === "string") {
        thinking += thinkRaw;
      } else if (Array.isArray(thinkRaw)) {
        for (const block of thinkRaw) {
          if (block?.type === "text" && typeof block.text === "string") {
            thinking += block.text;
          }
        }
      }
      // 正文 content
      if (part?.content) {
        for (const block of Array.isArray(part.content) ? part.content : [part.content]) {
          if (block?.type === "text" && typeof block.text === "string") {
            content += block.text;
          }
        }
      }
    }
  }
  return { content, thinking, isEnd: false };
}

/**
 * 调用上游对话接口（流式）
 * @param {object} options
 * @param {string} options.token 访客 token
 * @param {string} options.deviceId 设备 ID
 * @param {string} options.conversationId 会话 ID
 * @param {Array} options.messages OpenAI 风格 messages
 * @param {string} [options.model] 模型
 * @param {boolean} [options.thinking] 是否开启思考模式（deep_thinking）
 * @param {object} [options.metaData] 覆盖 meta_data
 * @param {AbortSignal} [options.signal]
 * @yields {Promise<{type: "content"|"thinking"|"end"|"error", content?: string, error?: Error}>}
 */
export async function* streamChat({
  token,
  deviceId,
  conversationId,
  messages,
  model = DEFAULT_MODEL,
  thinking = false,
  metaData = {},
  signal
}) {
  const body = {
    assistant_id: ASSISTANT_ID,
    conversation_id: conversationId,
    chat_type: "user_chat",
    meta_data: {
      selected_model: model,
      chat_mode: thinking ? "deep_thinking" : "normal",
      is_networking: false,
      platform: "pc",
      ...metaData
    },
    messages: normalizeMessages(messages)
  };
  const headers = buildSignedHeaders({ token, deviceId });

  const response = await new Promise((resolve, reject) => {
    const req = request({
      hostname: "chatglm.cn",
      path: STREAM_URL,
      method: "POST",
      headers: {
        ...headers,
        "content-length": Buffer.byteLength(JSON.stringify(body))
      },
      signal
    }, (res) => resolve(res));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });

  if (response.statusCode !== 200) {
    let errorText = "";
    for await (const chunk of response) {
      errorText += chunk.toString("utf8");
      if (errorText.length > 500) break;
    }
    let code = "UPSTREAM_ERROR";
    try {
      const parsed = JSON.parse(errorText);
      code = `GLM_${parsed.status ?? "ERROR"}`;
    } catch {}
    throw new Error(`Upstream ${response.statusCode}: ${errorText.slice(0, 200)}`, { cause: { code } });
  }

  for await (const event of parseSseStream(response)) {
    if (event.data === "[DONE]") {
      yield { type: "end" };
      return;
    }
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    const { content, thinking: thinkText, isEnd } = extractDelta(payload);
    if (isEnd) {
      yield { type: "end" };
      return;
    }
    if (thinkText) {
      yield { type: "thinking", content: thinkText };
    }
    if (content) {
      yield { type: "content", content };
    }
  }
  yield { type: "end" };
}

/** 把 OpenAI 风格 messages 转为 GLM content 数组格式 */
export function normalizeMessages(messages) {
  return (messages ?? []).map((msg) => {
    const content = Array.isArray(msg.content)
      ? msg.content
      : [{ type: "text", text: String(msg.content ?? "") }];
    return { role: msg.role, content };
  });
}
