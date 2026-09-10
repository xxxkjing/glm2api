import { test } from "node:test";
import assert from "node:assert/strict";

import { SlidingWindowLimiter } from "../src/services/rate-limiter.js";

test("allows calls within window", () => {
  const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 3, minIntervalMs: 0 });
  assert.equal(limiter.canCall("k", 1000), true);
  limiter.record("k", 1000);
  limiter.record("k", 1001);
  assert.equal(limiter.canCall("k", 1002), true);
  limiter.record("k", 1002);
  assert.equal(limiter.canCall("k", 1003), false); // 超 max
});

test("window slides over time", () => {
  const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 2, minIntervalMs: 0 });
  limiter.record("k", 1000);
  limiter.record("k", 1100);
  assert.equal(limiter.canCall("k", 2100), true); // 1000 过期，窗口内只剩 1
});

test("respects min interval", () => {
  const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 10, minIntervalMs: 500 });
  limiter.record("k", 1000);
  assert.equal(limiter.canCall("k", 1300), false); // 距上次 300ms < 500ms
  assert.equal(limiter.canCall("k", 1500), true); // 距上次 500ms 达标
});

test("waitMs reports time until allowed", () => {
  const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 1, minIntervalMs: 0 });
  limiter.record("k", 1000);
  assert.ok(limiter.waitMs("k", 1100) > 0);
  assert.equal(limiter.waitMs("k", 2001), 0); // 窗口过期
});