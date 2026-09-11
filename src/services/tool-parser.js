// 伪 FC 解析器：把模型返回的 <tool name="x">{json}</tool> XML（以及 DSML 变体）
// 解析成 OpenAI 兼容 tool_calls 数组。
// 裁剪自 deepseek2api openai-tool-parser.js。

import { randomUUID } from "node:crypto";

const TOOL_OPEN_PATTERN = /<tool\b([^>]*)>/gi;
const TOOL_CLOSE_PATTERN = /<\/tool\s*>/gi;
const TOOL_ATTR_PATTERN = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

function toStringSafe(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/** 清理 Markdown 代码块（保留含 <tool> 标签的块——可能是误判，宁可多收） */
function stripFencedCodeBlocks(text) {
  return toStringSafe(text).replace(/```([\s\S]*?)```/g, (match, content) =>
    /<tool\b/i.test(content) ? content : " "
  );
}

/** 归一化 QwenPaw 客户端的 DSML 工具标签（<|DSML|tool ...> 等）为标准 <tool ...> */
export function normalizeDsmlToolTags(text) {
  return toStringSafe(text)
    .replace(/<\s*[|｜\s]*DSML[|｜\s]*tool\b([^>]*)>/gi, (match, attrs) => `<tool${attrs}>`)
    .replace(/<\s*\/\s*[|｜\s]*DSML[|｜\s]*tool\s*>/gi, "</tool>");
}

function decodeXmlText(text) {
  return toStringSafe(text)
    .trim()
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&#x27;", "'");
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function isWhitespaceCharacter(character) {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

// 宽容 JSON 清洗：修正模型输出常见的不规范写法（单引号/注释/尾逗号/未引号 key）。
function sanitizeJsonText(input) {
  const text = toStringSafe(input);
  let output = "";
  let quote = null;
  let escaped = false;
  let previousSignificant = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (quote) {
      if (escaped) {
        if (quote === "'") {
          if (character === "'") output += "'";
          else if (character === "\"") output += "\\\"";
          else if (character === "\\") output += "\\\\";
          else output += `\\${character}`;
        } else {
          output += `\\${character}`;
        }
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        output += "\"";
        quote = null;
      } else if (character === "\n") {
        output += "\\n";
      } else if (character === "\r") {
        output += "\\r";
      } else if (character === "\t") {
        output += "\\t";
      } else {
        output += character;
      }
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      output += "\"";
      previousSignificant = "\"";
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && isWhitespaceCharacter(text[next])) next += 1;
      if (text[next] === "}" || text[next] === "]") { index += 1; continue; }
      output += character;
      previousSignificant = character;
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(character) && (previousSignificant === "{" || previousSignificant === ",")) {
      let end = index;
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
      let colon = end;
      while (colon < text.length && isWhitespaceCharacter(text[colon])) colon += 1;
      if (text[colon] === ":") {
        output += `"${text.slice(index, end)}"`;
        index = colon;
        previousSignificant = ":";
        continue;
      }
    }
    output += character;
    if (!isWhitespaceCharacter(character)) previousSignificant = character;
    index += 1;
  }
  return output;
}

function extractBalancedObject(text) {
  const source = toStringSafe(text);
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) { escaped = false; }
      else if (character === "\\") { escaped = true; }
      else if (character === quote) { quote = null; }
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (character === "{") { depth += 1; }
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parseLooseJsonObject(text) {
  const raw = toStringSafe(text).trim();
  if (!raw || raw === "null" || raw === "undefined" || raw === "NaN") return {};
  const attempts = [raw, sanitizeJsonText(raw)];
  for (const candidate of attempts) {
    const value = parseJsonObject(candidate);
    if (value) return value;
  }
  const balanced = extractBalancedObject(sanitizeJsonText(raw));
  if (balanced) {
    const value = parseJsonObject(balanced);
    if (value) return value;
  }
  return null;
}

function createParsedToolCall(name, input) {
  return {
    id: `call_${randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: { name, arguments: JSON.stringify(input) }
  };
}

function parseToolBodyCalls(name, bodyText) {
  const parsed = parseLooseJsonObject(bodyText);
  if (parsed === null) return [];
  // 数组包裹
  if (Array.isArray(parsed)) {
    return parsed
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => {
        const n = extractNameFromObject(item) || name;
        if (!n) return null;
        const { name: _, ...rest } = item;
        return createParsedToolCall(n, rest);
      })
      .filter(Boolean);
  }
  const effectiveName = name || extractNameFromObject(parsed) || "";
  if (!effectiveName) return [];
  const { name: _, ...rest } = parsed;
  return [createParsedToolCall(effectiveName, rest)];
}

function extractNameFromObject(value) {
  if (!value || typeof value !== "object") return "";
  const candidate = value.name ?? value.tool_name ?? value.function?.name;
  return typeof candidate === "string" ? candidate.trim() : "";
}

function isInsideJsonString(text) {
  let escaped = false;
  let insideString = false;
  for (const character of toStringSafe(text)) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && insideString) { escaped = true; continue; }
    if (character === "\"") { insideString = !insideString; }
  }
  return insideString;
}

function findToolClose(source, bodyStart) {
  TOOL_CLOSE_PATTERN.lastIndex = bodyStart;
  let match;
  while ((match = TOOL_CLOSE_PATTERN.exec(source))) {
    if (!isInsideJsonString(source.slice(bodyStart, match.index))) {
      return { end: match.index + match[0].length, index: match.index };
    }
  }
  return null;
}

function findToolName(attrs) {
  const match = toStringSafe(attrs).match(TOOL_ATTR_PATTERN);
  return decodeXmlText(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function parseCompactToolCalls(source) {
  const output = [];
  TOOL_OPEN_PATTERN.lastIndex = 0;
  let match;
  while ((match = TOOL_OPEN_PATTERN.exec(source))) {
    const name = findToolName(match[1]);
    const attributes = match[1] || "";
    const bodyStart = match.index + match[0].length;
    // 自闭合 <tool name="x"/>
    if (/\/\s*$/.test(attributes)) {
      if (name) output.push(createParsedToolCall(name, {}));
      continue;
    }
    const close = findToolClose(source, bodyStart);
    if (!close) break;
    const bodyText = decodeXmlText(source.slice(bodyStart, close.index)).trim();
    output.push(...parseToolBodyCalls(name, bodyText));
    TOOL_OPEN_PATTERN.lastIndex = close.end;
  }
  return output;
}

function filterAllowedToolCalls(calls, allowedToolNames) {
  if (!allowedToolNames?.length) return calls;
  const allowed = new Set(allowedToolNames.map((n) => toStringSafe(n).trim()).filter(Boolean));
  return calls.filter((call) => allowed.has(call.name));
}

/**
 * 从文本解析出 tool_calls。
 * @param {string} text 模型原始输出
 * @param {string[]} [allowedToolNames] 白名单（空则不过滤）
 * @returns {object[]} 形如 [{id,type,function:{name,arguments}}]
 */
export function parseToolCallsFromText(text, allowedToolNames = []) {
  const source = stripFencedCodeBlocks(normalizeDsmlToolTags(text));
  if (!source.match(/<tool\b/i)) return [];
  return filterAllowedToolCalls(parseCompactToolCalls(source), allowedToolNames);
}

/** 一次性解析（非流式用） */
export function extractToolCalls(text, allowedToolNames) {
  return parseToolCallsFromText(text, allowedToolNames);
}
