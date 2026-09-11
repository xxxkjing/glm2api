// 流式工具调用解析器（sieve）
// 用 indexOf 替代共享正则，避免 lastIndex 污染。

import { randomUUID } from "node:crypto";

const TAG_OPEN = "<tool";
const TAG_CLOSE = "</tool>";
const SELF_CLOSE_MARKER = "/>";

function toStringSafe(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function isInsideJsonString(text) {
  let escaped = false;
  let inside = false;
  for (const ch of toStringSafe(text)) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === "\"") { inside = !inside; }
  }
  return inside;
}

function decodeXmlText(s) {
  return toStringSafe(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&#x27;", "'");
}

function findNextTagOpen(source, offset) {
  let idx = source.indexOf(TAG_OPEN, offset);
  while (idx >= 0) {
    const tail = source.slice(idx);
    // 确认是 <tool 开头（不是 </tool 或其他）
    if (/^<tool\b/i.test(tail) && !/^<\/tool\b/i.test(tail)) {
      // 检查是否在 JSON 字符串里
      if (!isInsideJsonString(source.slice(0, idx))) return idx;
    }
    idx = source.indexOf(TAG_OPEN, idx + 1);
  }
  return -1;
}

function findNextTagClose(source, offset) {
  let idx = source.indexOf(TAG_CLOSE, offset);
  // 找到第一个闭合标签即返回（工具调用格式下 </tool> 几乎不会出现在 JSON 字符串值里）
  return idx;
}

function extractAttrs(openTagBody) {
  // 找 name="..." 或 name='...' 或 name=unquoted
  const m = openTagBody.match(/(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
}

function parseBody(name, bodyText) {
  const decoded = decodeXmlText(bodyText).trim();
  if (!decoded) return [{ id: `call_${randomUUID().replace(/-/g, "")}`, type: "function", function: { name, arguments: "{}" } }];
  let parsed = null;
  try { parsed = JSON.parse(decoded); } catch {
    const cleaned = decoded
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '"$1":')
      .replace(/'([^']*)'/g, '"$1"')
      .replace(/,\s*([}\]])/g, "$1");
    try { parsed = JSON.parse(cleaned); } catch {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{ id: `call_${randomUUID().replace(/-/g, "")}`, type: "function", function: { name, arguments: decoded } }];
  }
  return [{ id: `call_${randomUUID().replace(/-/g, "")}`, type: "function", function: { name, arguments: JSON.stringify(parsed) } }];
}

export function createToolSieve(_allowedToolNames = []) {
  let pending = "";

  function drain() {
    const events = [];
    let searchFrom = 0;
    while (true) {
      const openIdx = findNextTagOpen(pending, searchFrom);
      if (openIdx < 0) break;
      // 提取 <tool ...> 的范围（到第一个 >）
      const tagStart = openIdx;
      const gtIdx = pending.indexOf(">", tagStart);
      if (gtIdx < 0) break; // 标签未闭合（没找到 >）
      const openTagEnd = gtIdx + 1;
      const openBody = pending.slice(tagStart + TAG_OPEN.length, gtIdx).trim();
      const name = extractAttrs(openBody);
      const selfClose = openBody.endsWith("/");
      let closeIdx;
      if (selfClose) {
        closeIdx = openTagEnd;
      } else {
        closeIdx = findNextTagClose(pending, openTagEnd);
        if (closeIdx < 0) break; // 没找到闭合
      }
      const prefix = pending.slice(searchFrom, tagStart);
      if (prefix) events.push({ type: "text", text: prefix });
      const body = selfClose ? "" : pending.slice(openTagEnd, closeIdx);
      const calls = parseBody(name, body);
      for (const c of calls) events.push({ type: "tool_calls", calls: [c] });
      searchFrom = closeIdx + TAG_CLOSE.length; // 跳过闭合标签
    }
    pending = pending.slice(searchFrom);
    return events;
  }

  return Object.freeze({
    flush() {
      const events = drain();
      if (pending) { events.push({ type: "text", text: pending }); pending = ""; }
      return events;
    },
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : toStringSafe(chunk);
      return drain();
    }
  });
}

export function splitToolAwareEvents(text, allowedToolNames = []) {
  const sieve = createToolSieve(allowedToolNames);
  const events = [...sieve.push(text), ...sieve.flush()];
  const out = [];
  for (const e of events) {
    if (e.type === "text") {
      if (out.length && out.at(-1).type === "text") out.at(-1).text += e.text;
      else out.push(e);
    } else out.push(e);
  }
  return out;
}

export function extractToolAwareOutput(text, allowedToolNames = []) {
  const events = splitToolAwareEvents(text, allowedToolNames);
  const content = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  const toolCalls = events.flatMap((e) => e.type === "tool_calls" ? e.calls ?? [] : []);
  return { content, toolCalls, events };
}
