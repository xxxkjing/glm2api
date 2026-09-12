// 伪 FC prompt 构建：把 tools 定义拼成 system message，告诉模型输出 XML 标签格式。
// 裁剪自 deepseek2api openai-tool-prompt.js。

import { getToolFunction, getToolName, resolveToolChoicePolicy } from "./tool-policy.js";

function toStringSafe(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function toJsonText(value, fallback = "{}") {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  try {
    return JSON.stringify(value ?? {}) || fallback;
  } catch {
    return fallback;
  }
}

function escapeXmlAttribute(text) {
  return toStringSafe(text)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 把 OpenAI 风格的 tool_calls（message.tool_calls）序列化成 prompt 里的 [Previous tool calls] 块 */
function formatPromptToolCalls(toolCalls, toolNameById) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
  const blocks = toolCalls
    .map((call) => {
      const name = getToolName(call);
      const callId = toStringSafe(call?.id).trim();
      const args = (call?.function?.arguments ?? call?.input ?? "{}").toString();
      if (!name) return "";
      if (callId) toolNameById.set(callId, name);
      return `<tool name="${escapeXmlAttribute(name)}">${escapeXmlAttribute(args)}</tool>`;
    })
    .filter(Boolean);
  return blocks.length ? `[Previous tool calls]\n${blocks.join("\n")}` : "";
}

/** 规范化 assistant 消息：正文 + tool_calls 历史合入一个 content */
function normalizeAssistantContent(message, toolNameById) {
  const content = normalizeContentText(message?.content).trim();
  const history = formatPromptToolCalls(message?.tool_calls, toolNameById);
  if (!content) return history;
  if (!history) return content;
  return `${content}\n\n${history}`;
}

/** 规范化 tool result 消息 */
function normalizeToolContent(message, toolNameById) {
  const content = normalizeContentText(message?.content).trim() || "null";
  const callId = toStringSafe(message?.tool_call_id).trim() || "";
  const nameFromCall = callId ? (toolNameById.get(callId) || "") : "";
  const nameFromMsg = toStringSafe(message?.name).trim();
  const name = nameFromCall || nameFromMsg || "";
  return name ? `Tool result for ${name}:\n${content}` : content;
}

function normalizeContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      return toStringSafe(item.text ?? item.output_text ?? item.content);
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeMessageRole(role) {
  return role === "developer" ? "system" : role;
}

/**
 * 把 OpenAI 风格 messages 转成 GLM 上游能消费的纯文本消息列表。
 * 工具历史会被内联为 XML，tool result 会被转成 user 消息的文本。
 */
export function normalizeMessagesForGlM(messages, allowedToolNames = []) {
  const toolNameById = new Map();
  return (messages ?? [])
    .flatMap((message) => {
      const role = normalizeMessageRole(toStringSafe(message?.role).trim().toLowerCase() || "user");
      if (role === "assistant") {
        const text = normalizeAssistantContent(message, toolNameById);
        return text ? [{ role, content: [{ type: "text", text }] }] : [];
      }
      if (role === "tool" || role === "function") {
        return [{ role: "user", content: [{ type: "text", text: normalizeToolContent(message, toolNameById) }] }];
      }
      return [{ role, content: [{ type: "text", text: normalizeContentText(message?.content) }] }];
    });
}

/** 把 tools 定义拼成一段 system prompt 文本，让模型知道可用工具和输出格式 */
export function buildToolPrompt(tools, toolChoice) {
  const policy = resolveToolChoicePolicy({ tools, toolChoice });
  const allowed = new Set(policy.allowedToolNames);

  const schemas = (tools ?? [])
    .filter((t) => allowed.has(getToolName(t)))
    .map((tool) => {
      const fn = getToolFunction(tool);
      const name = getToolName(tool);
      if (!name) return null;
      return { name, description: toStringSafe(fn?.description).trim(), parameters: fn?.parameters ?? {} };
    })
    .filter(Boolean);

  if (!schemas.length) return { prompt: "", policy };

  const parts = [
    "You can call the following tools when needed:",
    toJsonText(schemas, "[]"),
    "",
    "Output format for tool calls:",
    '<tool name="TOOL_NAME">{"argument":"value"}</tool>',
    "",
    "Multiple independent calls go on separate lines:",
    '<tool name="FIRST_TOOL">{"argument":"a"}</tool>',
    '<tool name="SECOND_TOOL">{"argument":"b"}</tool>',
    "",
    "Rules:",
    "1) When calling tools, output ONLY the <tool> tags — no extra prose.",
    "2) The tag body must be a strict JSON object; string keys and values use double quotes.",
    "3) Use exactly a listed tool name and only fields from its schema.",
    "4) One tag = one call. Do not wrap multiple calls in one tag.",
    "5) Emit only calls that can be made now; wait for results before dependent calls.",
    "6) Do NOT use markdown code fences around tool calls.",
    "",
    "中文要求（同样必须遵守）：",
    "7) 如果用户请求的事项需要调用工具来完成（查天气/搜索/计算/查资料等），你必须输出 <tool> 标签，绝不能只给文字回答。",
    "8) 输出格式示例：<tool name=\"get_weather\">{\"city\":\"北京\"}</tool>",
    "9) 不要用 markdown 代码块包住工具调用，直接输出标签本身。"
  ];

  if (policy.mode === "required") {
    parts.push("10) You MUST call at least one tool this turn. 这一轮必须至少调用一次工具。");
  }
  if (policy.mode === "forced") {
    parts.push(`10) You MUST call this exact tool: ${policy.forcedName}. 这一轮必须调用指定工具。`);
  }

  const prompt = parts.join("\n");
  return { prompt, policy };
}

/**
 * 把工具说明注入到 messages 头部（作为首个 system）。
 * 这样模型从一开始就知道工具，遵循率更高。
 */
export function injectToolPrompt(messages, toolPrompt) {
  if (!toolPrompt) return messages;
  return [
    { role: "system", content: [{ type: "text", text: toolPrompt }] },
    ...messages
  ];
}

/**
 * 构建发给上游的完整 messages：注入工具 prompt + 归一化 tool_calls 历史。
 * @returns {{messages, policy, toolNames:string[]}}
 */
export function buildPromptWithTools({ messages, toolChoice, tools }) {
  const { prompt: toolPrompt, policy } = buildToolPrompt(tools, toolChoice);
  const normalized = normalizeMessagesForGlM(messages, policy.allowedToolNames);
  const finalMessages = injectToolPrompt(normalized, toolPrompt);
  return {
    messages: finalMessages,
    policy,
    toolNames: policy.allowedToolNames
  };
}
