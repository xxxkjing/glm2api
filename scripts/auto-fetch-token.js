#!/usr/bin/env node
// 自动获取 chatglm.cn 匿名访客 token：Playwright 打开页面 → 读 cookie → 注入会话池
// 用法：node scripts/auto-fetch-token.js [--quiet]
// 返回：成功时打印 token（--quiet 只打印 token 本身，供脚本调用）
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GuestSession, GuestSessionPool, decodeJwtPayload } from "../src/services/guest-session.js";

const dataFile = process.env.GLM2API_DATA_FILE ?? resolve("./data/glm2api.json");
const quiet = process.argv.includes("--quiet");
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

const log = (msg) => { if (!quiet) console.log(msg); };

async function main() {
  log("[auto-fetch] 启动 chromium…");
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();

  log("[auto-fetch] 打开 chatglm.cn 匿名页面…");
  await page.goto("https://chatglm.cn/", { waitUntil: "domcontentloaded", timeout: 30000 });
  // 等 cookie 下发
  await page.waitForTimeout(4000);

  const cookies = await ctx.cookies();
  const tokenCookie = cookies.find((c) => c.name === "chatglm_token");
  const deid = cookies.find((c) => c.name === "chatglm-deid");

  await browser.close();

  if (!tokenCookie?.value || !tokenCookie.value.startsWith("eyJ")) {
    log("[auto-fetch] ✗ 未抓到 chatglm_token（可能需要手动或页面未初始化）");
    process.exit(1);
  }
  const token = tokenCookie.value;
  const deviceId = decodeJwtPayload(token)?.device_id ?? deid?.value ?? undefined;
  log(`[auto-fetch] ✓ 抓到 token（${token.slice(0, 20)}…，deviceId=${deviceId?.slice(0, 8)}…）`);

  // 注入会话池
  let pool = new GuestSessionPool();
  try {
    if (existsSync(dataFile)) {
      pool = GuestSessionPool.fromJSON(JSON.parse(readFileSync(dataFile, "utf8")));
    }
  } catch (e) {
    log(`[auto-fetch] 读池失败（${e.message}），新建`);
  }
  if (pool.sessions.some((s) => s.token === token)) {
    log("[auto-fetch] token 已在池中，跳过");
  } else {
    pool.add(new GuestSession({ token, deviceId }));
    writeFileSync(dataFile, JSON.stringify(pool.toJSON ? pool.toJSON() : { sessions: pool.sessions, cooling: [] }, null, 2));
    log(`[auto-fetch] ✓ 已注入会话池（现共 ${pool.size} 个）`);
  }

  if (quiet) console.log(token);
}

main().catch((e) => {
  console.error("[auto-fetch] ✗", e.message);
  process.exit(1);
});
