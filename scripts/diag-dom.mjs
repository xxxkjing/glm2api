#!/usr/bin/env node
// 诊断：发一条带工具的问题，打印 readLastReply 前容器原始 innerText（尾部 800 字符）
import { chromium } from "playwright-core";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.goto("https://chatglm.cn/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);

  const input = page.locator("textarea, [contenteditable=true]").first();
  await input.click();
  await page.keyboard.type("用一句话介绍你自己", { delay: 20 });
  await page.keyboard.press("Enter");

  let raw = null;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    raw = await page.evaluate(() => {
      const container = document.querySelector(".conversation-inner");
      if (!container) return null;
      return container.innerText || "";
    });
    if (raw && raw.includes("ChatGLM\n") && /介绍我自己|我是|大家好|清言|模型/.test(raw)) {
      const m = [...raw.matchAll(/ChatGLM(?=\n)/g)];
      const idx = m.length ? m[m.length - 1].index : -1;
      if (idx >= 0 && raw.slice(idx).length > 40) break;
    }
  }
  await browser.close();
  if (!raw) { console.log("未抓到"); return; }
  console.log("=== 原始 innerText 尾部 900 字符 ===");
  console.log(JSON.stringify(raw.slice(-900)));
  console.log("\n=== ChatGLM 出现位置 ===");
  console.log([...raw.matchAll(/ChatGLM/g)].map(m => m.index));
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });