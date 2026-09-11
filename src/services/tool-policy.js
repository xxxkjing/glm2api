// 工具策略：解析 OpenAI tools / tool_choice，决定允许的工具备选与模式。
// 裁剪自 deepseek2api openai-tool-policy.js，错误类型自带以便路由映射为 OpenAI 400/422。

const TOOL_CHOICE_AUTO = "auto";
const TOOL_CHOICE_NONE = "none";
const TOOL_CHOICE_REQUIRED = "required";
const TOOL_CHOICE_FORCED = "forced";

function toStringSafe(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/** 抛出可被路由捕获的 OpenAI 兼容错误 */
export class ToolChoiceError extends Error {
  constructor(status, message, code = "invalid_request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getToolFunction(tool) {
  if (!tool || typeof tool !== "object") return null;
  return tool.function && typeof tool.function === "object" ? tool.function : tool;
}

export function getToolName(tool) {
  return toStringSafe(getToolFunction(tool)?.name).trim();
}

function extractDeclaredToolNames(tools) {
  return Array.isArray(tools) ? tools.map(getToolName).filter(Boolean) : [];
}

function hasMessageTooling(messages) {
  return Array.isArray(messages) && messages.some((message) => {
    const role = toStringSafe(message?.role).trim().toLowerCase();
    return role === "tool" || role === "function" || Array.isArray(message?.tool_calls);
  });
}

/** 请求是否携带任何工具语义（tools / tool_choice / 历史 tool 消息） */
export function hasChatToolingRequest(body) {
  return Boolean(
    (Array.isArray(body?.tools) && body.tools.length > 0)
    || body?.tool_choice !== undefined
    || hasMessageTooling(body?.messages)
  );
}

function parseForcedToolName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") {
    return "";
  }
  if (toStringSafe(toolChoice.type).trim() !== "function") {
    throw new ToolChoiceError(400, `Unsupported tool_choice.type: ${toolChoice.type || ""}`);
  }
  const name = toStringSafe(toolChoice.function?.name ?? toolChoice.name).trim();
  if (!name) {
    throw new ToolChoiceError(400, "tool_choice function requires name");
  }
  return name;
}

/**
 * 解析 tool_choice 策略。
 * @returns {{allowedToolNames:string[], declaredToolNames:string[], forcedName:string, mode:string}}
 */
export function resolveToolChoicePolicy({ tools, toolChoice }) {
  const declaredToolNames = extractDeclaredToolNames(tools);
  if (!declaredToolNames.length) {
    if (toolChoice === undefined || toolChoice === null) {
      return { allowedToolNames: [], declaredToolNames, forcedName: "", mode: TOOL_CHOICE_NONE };
    }
    throw new ToolChoiceError(400, "tool_choice requires non-empty tools");
  }

  if (toolChoice === undefined || toolChoice === null || toolChoice === TOOL_CHOICE_AUTO) {
    return { allowedToolNames: declaredToolNames, declaredToolNames, forcedName: "", mode: TOOL_CHOICE_AUTO };
  }
  if (toolChoice === TOOL_CHOICE_NONE) {
    return { allowedToolNames: [], declaredToolNames, forcedName: "", mode: TOOL_CHOICE_NONE };
  }
  if (toolChoice === TOOL_CHOICE_REQUIRED) {
    return { allowedToolNames: declaredToolNames, declaredToolNames, forcedName: "", mode: TOOL_CHOICE_REQUIRED };
  }

  const forcedName = parseForcedToolName(toolChoice);
  if (!declaredToolNames.includes(forcedName)) {
    throw new ToolChoiceError(400, `tool_choice forced function "${forcedName}" is not declared in tools`);
  }
  return {
    allowedToolNames: [forcedName],
    declaredToolNames,
    forcedName,
    mode: TOOL_CHOICE_FORCED
  };
}

/** 校验 required/forced 是否被满足；不满足则抛 422（调用方决定是否重试/降级） */
export function ensureToolChoiceSatisfied(policy, calls) {
  if (policy.mode === TOOL_CHOICE_REQUIRED && !calls.length) {
    throw new ToolChoiceError(422, "tool_choice requires at least one valid tool call.", "tool_choice_violation");
  }
  if (policy.mode === TOOL_CHOICE_FORCED && !calls.some((call) => call.name === policy.forcedName)) {
    throw new ToolChoiceError(422, `tool_choice requires tool "${policy.forcedName}".`, "tool_choice_violation");
  }
}

export { TOOL_CHOICE_AUTO, TOOL_CHOICE_NONE, TOOL_CHOICE_REQUIRED, TOOL_CHOICE_FORCED };
