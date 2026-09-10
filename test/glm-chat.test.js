import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { parseSseStream, extractDelta, normalizeMessages } from "../src/services/glm-chat.js";

async function* iter(stream) {
  for await (const chunk of stream) {
    yield chunk;
  }
}

test("parseSseStream parses data events", async () => {
  const stream = Readable.from([
    Buffer.from('data: {"a":1}\n\n'),
    Buffer.from('data: {"b":2}\n\n'),
    Buffer.from("data: [DONE]\n\n")
  ]);
  const events = [];
  for await (const e of parseSseStream(iter(stream))) {
    events.push(e);
  }
  assert.equal(events.length, 3);
  assert.equal(events[0].data, '{"a":1}');
  assert.equal(events[2].data, "[DONE]");
});

test("parseSseStream handles chunk boundaries", async () => {
  // 事件被切分到多个 chunk
  const stream = Readable.from([
    Buffer.from('data: {"a"'),
    Buffer.from(':1}\n\ndata: {"b"'),
    Buffer.from(':2}\n\n')
  ]);
  const events = [];
  for await (const e of parseSseStream(iter(stream))) {
    events.push(e);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].data, '{"a":1}');
  assert.equal(events[1].data, '{"b":2}');
});

test("extractDelta pulls assistant text from parts", () => {
  const payload = {
    id: "x",
    parts: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }] }
    ]
  };
  const { content, isEnd } = extractDelta(payload);
  assert.equal(content, "你好世界");
  assert.equal(isEnd, false);
});

test("extractDelta handles finish status", () => {
  const { isEnd } = extractDelta({ status: "finish" });
  assert.equal(isEnd, true);
});

test("extractDelta pulls thinking content", () => {
  const payload = {
    parts: [
      { role: "assistant", thinking_content: "让我想想...", content: [{ type: "text", text: "答案" }] }
    ]
  };
  const { content, thinking } = extractDelta(payload);
  assert.equal(thinking, "让我想想...");
  assert.equal(content, "答案");
});

test("normalizeMessages converts string content to blocks", () => {
  const out = normalizeMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }] }
  ]);
  assert.deepEqual(out[0].content, [{ type: "text", text: "hi" }]);
  assert.deepEqual(out[1].content, [{ type: "text", text: "hello" }]);
});
