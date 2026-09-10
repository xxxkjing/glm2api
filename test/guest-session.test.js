import { test } from "node:test";
import assert from "node:assert/strict";

import { GuestSession, GuestSessionPool, decodeJwtPayload } from "../src/services/guest-session.js";

const SAMPLE_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaXNfZ3Vlc3QiOnRydWUsImV4cCI6MTc4OTA4NjY5OSwiaWF0IjoxNzg5MDAwMjk5fQ.signature";

test("decodeJwtPayload parses guest claims", () => {
  const payload = decodeJwtPayload(SAMPLE_TOKEN);
  assert.equal(payload.is_guest, true);
  assert.equal(payload.sub, "test");
});

test("GuestSession stores token and device", () => {
  const session = new GuestSession({ token: SAMPLE_TOKEN, deviceId: "dev-1" });
  assert.equal(session.token, SAMPLE_TOKEN);
  assert.equal(session.deviceId, "dev-1");
  assert.equal(session.role, "guest");
  // 样例 token exp=1789086699（2026-09-10），当前时间应未过期
  assert.equal(session.isExpired(Date.now()), false);
});

test("GuestSession isExpired respects exp", () => {
  const session = new GuestSession({ token: SAMPLE_TOKEN, deviceId: "dev-1" });
  // 在 exp 之前：未过期
  assert.equal(session.isExpired(1789086698000), false);
  // 在 exp 之后：过期
  assert.equal(session.isExpired(1789086700000), true);
});

test("GuestSession detects clearly expired token", () => {
  // 过期 token：exp=1000000000（2001 年）
  const expiredToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwiaXNfZ3Vlc3QiOnRydWUsImV4cCI6MTAwMDAwMDAwMH0.sig";
  const session = new GuestSession({ token: expiredToken, deviceId: "d" });
  assert.equal(session.isExpired(Date.now()), true);
});

test("GuestSession round-trips through JSON", () => {
  const session = new GuestSession({ token: SAMPLE_TOKEN, deviceId: "dev-2", uid: "u1" });
  const restored = GuestSession.fromJSON(session.toJSON());
  assert.equal(restored.token, SAMPLE_TOKEN);
  assert.equal(restored.deviceId, "dev-2");
  assert.equal(restored.uid, "u1");
});

test("GuestSessionPool rotates and handles rate limiting", () => {
  const pool = new GuestSessionPool([
    new GuestSession({ token: "a", deviceId: "d1" }),
    new GuestSession({ token: "b", deviceId: "d2" })
  ]);
  const first = pool.take();
  assert.equal(first.token, "a");
  // 轮转后第二个
  const second = pool.take();
  assert.equal(second.token, "b");
  // 标记限流后：进入冷却，availableSize 减 1（size 不变）
  pool.markRateLimited("a");
  assert.equal(pool.size, 2);
  assert.equal(pool.availableSize(), 1);
  // 冷却中 take 不会取到 a
  assert.equal(pool.take().token, "b");
});

test("GuestSessionPool waits for cooling before reuse", () => {
  const pool = new GuestSessionPool([
    new GuestSession({ token: "a", deviceId: "d1" }),
    new GuestSession({ token: "b", deviceId: "d2" })
  ]);
  // 标记 a 限流（冷却 30min）
  pool.markRateLimited("a", 30 * 60 * 1000);
  // 现在只能取 b
  assert.equal(pool.take().token, "b");
  // availableSize 只有 1
  assert.equal(pool.availableSize(), 1);
  // 模拟 31 分钟后：a 恢复
  const future = Date.now() + 31 * 60 * 1000;
  assert.ok(pool.availableSize(future) > 1);
});

test("GuestSessionPool persists cooling via JSON", () => {
  const pool = new GuestSessionPool([
    new GuestSession({ token: "a", deviceId: "d1" })
  ]);
  pool.markRateLimited("a", 60_000);
  const data = pool.toJSON();
  const restored = GuestSessionPool.fromJSON(data);
  assert.equal(restored.availableSize(), 0); // 冷却中
  assert.ok(restored.cooling.has("a"));
});
