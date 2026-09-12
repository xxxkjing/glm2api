#!/usr/bin/env node
// 诊断：chatglm 页面输入框附近有哪些按钮（联网/搜索开关），找可点击的
import { chromium } from "playwright-core";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.goto("https://chatglm.cn/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);

  // 列出文本中含 联网/搜索/网络 的可点击元素
  const found = await page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll("button, [role=button], [class*=switch], [class*=toggle], [class*=search], [class*=network], [class*=net]");
    for (const el of els) {
      const t = (el.textContent || "").trim();
      const cls = (el.className || "").toString().slice(0, 60);
      if (t.includes("联网") || t.includes("搜索") || t.includes("网络") || /search|net|switch|toggle/i.test(cls)) {
        out.push({ tag: el.tagName, text: t.slice(0, 40), cls });
      }
    }
    return out;
  });
  console.log("=== 候选按钮 ===");
  console.log(JSON.stringify(found, null, 1));
  // 也 dump 输入框上方区域按钮
  const near = await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return [];
    const parent = ta.closest("div[class*=input], div[class*=composer], div[class*=footer]") || ta.parentElement;
    const btns = parent ? parent.querySelectorAll("button") : [];
    return Array.from(btns).map(b => ({ text: (b.textContent||"").trim().slice(0,30), cls: (b.className||"").toString().slice(0,50), title: b.getAttribute?.("title")||"" }));
  });
  console.log("=== 输入框附近按钮 ===");
  console.log(JSON.stringify(near, null, 1));
  await browser.close();
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });