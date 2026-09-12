// 浏览器驱动对话后端（方案 C：Playwright 操作 chatglm.cn 匿名页面）
// 绕过 API 直调风控（40012）：请求由真实浏览器页面发出，身份/会话/额度由页面自动管理。
// 对话方式：textarea 输入 → 回车 → 轮询捕获最后一条 assistant 回复的文本增量。
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";

const CHATGLM_URL = "https://chatglm.cn/";
const EXECUTABLE = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const POLL_MS = Number(process.env.BROWSER_POLL_MS || 300);
const IDLE_BEFORE_DONE_MS = Number(process.env.BROWSER_IDLE_MS || 2500);
const MAX_WAIT_MS = Number(process.env.BROWSER_MAX_WAIT_MS || 120000);
// 每身份最多对话次数（guest 额度约 4 次/身份，留 1 次余量）
const MAX_CHAT_PER_IDENTITY = Number(process.env.BROWSER_MAX_CHAT || 3);

let browser = null;
let page = null;
let busy = false;
let chatCount = 0;

/** 等待页面文本选择器出现（轮询，避免依赖 React 渲染时机） */
async function waitFor(selector, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const el = await page.$(selector);
      if (el) return el;
    } catch {}
    await page.waitForTimeout(300);
  }
  throw new Error(`waitFor timeout: ${selector}`);
}

/** 启动/复用浏览器实例并打开 chatglm.cn */
export async function initBrowser() {
  if (browser && page) return page;
  browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const ctx = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
  });
  page = await ctx.newPage();
  await page.goto(CHATGLM_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await waitFor("textarea", 30000);
  return page;
}

/** 关闭浏览器（释放资源） */
export async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
}

/** 轮换匿名身份：清 cookie + 换 chatglm-deid + 刷新页面（guest 额度用尽前主动换身份） */
export async function rotateIdentity() {
  if (!page) return;
  await page.evaluate(() => {
    localStorage.clear();
    const newId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("chatglm-deid", newId);
  });
  await page.context().clearCookies().catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await waitFor("textarea", 30000).catch(() => {});
  // 新身份冷启动：给页面额外时间完成身份建立与建议区渲染
  await page.waitForTimeout(4000);
  chatCount = 0;
}

/** 向输入框填入文本（React 受控组件需用原生 setter + input 事件） */
async function typeIntoInput(text) {
  await page.evaluate((t) => {
    const ta = document.querySelector("textarea");
    if (!ta) throw new Error("textarea not found");
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, t);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

/** 按回车发送 */
async function pressEnter() {
  await page.keyboard.press("Enter");
}

/**
 * 读取最后一条 assistant 回复的「思考」与「正文」
 * 页面结构（deep_thinking）：ChatGLM\n思考过程…\n思考结束\n\n<final 正文>（亦可能无思考）
 * @returns {{ thinking: string, content: string }}
 */
async function readLastReply() {
  return await page.evaluate(() => {
    const container = document.querySelector(".conversation-inner");
    if (!container) return { thinking: "", content: "" };
    const text = container.innerText || "";
    // 「ChatGLM」模型名标记后紧跟换行；排除页脚「ChatGLM5」（无换行边界）
    const matches = [...text.matchAll(/ChatGLM(?=\n)/g)];
    const idx = matches.length ? matches[matches.length - 1].index : -1;
    if (idx < 0) return { thinking: "", content: "" };
    let after = text.slice(idx + "ChatGLM".length);
    // 去掉后续用户气泡
    const uidx = after.indexOf("访客_");
    if (uidx >= 0) after = after.slice(0, uidx);
    // 结构性清理：页脚锚点 + 常见单句引导语（不依赖动态建议区文案）
    for (const anchor of ["内容由AI生成", "GLM-Flash极致", "和我聊聊天吧", "和你聊聊天吧", "用户协议", "隐私政策", "开源模型", "你会做什么？", "你能做什么？", "有什么特别的技能？", "推荐一些好玩的游戏？"]) {
      const ai = after.indexOf(anchor);
      if (ai >= 0) after = after.slice(0, ai);
    }
    // 清理联网搜索引用尾巴：正文出现「【turn0...」即截断（正文已结束，后面是来源引用/建议区）
    {
      const turnIdx = after.search(/【\s*turn\d/i);
      if (turnIdx >= 0) after = after.slice(0, turnIdx);
    }
    // 结构性清理：正文后连着的「建议提问区」（≥2 个以？结尾的短行）从第一个问句处切掉
    {
      const lines = after.split("\n");
      let cutLine = -1;
      let qCount = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i].trim();
        if (ln.endsWith("？") || ln.endsWith("?")) {
          if (qCount === 0) cutLine = i;
          qCount += 1;
          if (qCount >= 2) {
            cutLine = i;
            break;
          }
        } else if (ln) {
          if (qCount > 0) break; // 问句区之后又出现正文行，停止回溯
        }
      }
      if (qCount >= 2 && cutLine >= 0) {
        after = lines.slice(0, cutLine).join("\n");
      }
    }
    // 思考结束标记后再截正文；无标记时正文未开始（全部视为思考中）
    const thinkEnd = after.indexOf("思考结束");
    let thinking = "";
    let content = "";
    if (thinkEnd >= 0) {
      thinking = after.slice(0, thinkEnd);
      content = after.slice(thinkEnd + "思考结束".length);
    } else {
      thinking = after; // 思考进行中：正文尚未出现
    }
    const clean = (s) => s.replace(/\s+\n/g, "\n").trim();
    return { thinking: clean(thinking), content: clean(content) };
  });
}

/**
 * 流式对话：发送消息并增量产出 assistant 回复文本（正文，跳过思考过程）
 * @param {string} text 用户消息
 * @param {object} opts { thinking?: boolean 是否转发思考内容, signal }
 * @yields {{type:"content"|"thinking"|"end"|"error", content?:string, error?:Error}}
 */
export async function* chatStream({ text, thinking = false, signal }) {
  if (!page) await initBrowser();
  if (busy) throw new Error("browser driver busy: another chat in progress");
  busy = true;
  try {
    // 先读基线（排除发消息前页面已有内容/页脚容器）
    const base = await readLastReply();
    let prevThinking = base.thinking;
    let prevContent = base.content;

    await typeIntoInput(text);
    await pressEnter();

    const start = Date.now();
    let idleMs = 0;
    let done = false;
    // 思考过程中的停顿不应算空转：只在「正文已出现过」后累计 idle
    let sawContent = false;

    while (Date.now() - start < MAX_WAIT_MS) {
      if (signal?.aborted) {
        yield { type: "error", error: new Error("aborted") };
        return;
      }
      await page.waitForTimeout(POLL_MS);
      const { thinking: thiRaw, content: conRaw } = await readLastReply();

      // thinking 增量
      if (thinking && thiRaw.length > prevThinking.length) {
        const inc = thiRaw.slice(prevThinking.length);
        prevThinking = thiRaw;
        if (inc.trim()) yield { type: "thinking", content: inc };
      }

      // content 增量（容器重建/切换时长度回退 → 重置基线，不产生脏增量）
      if (conRaw.length < prevContent.length - 30) {
        prevContent = conRaw; // 容器切换：重新对齐
        idleMs = 0;
      } else if (conRaw.length > prevContent.length) {
        const inc = conRaw.slice(prevContent.length);
        prevContent = conRaw;
        sawContent = true;
        idleMs = 0;
        if (inc.trim()) yield { type: "content", content: inc };
      } else if (sawContent) {
        idleMs += POLL_MS;
        if (idleMs >= IDLE_BEFORE_DONE_MS) {
          done = true;
          break;
        }
      }
    }
    if (!done && !sawContent) {
      yield { type: "error", error: new Error("no reply within timeout") };
      return;
    }
    // 对话成功：计数，达到阈值主动轮换身份
    chatCount += 1;
    if (chatCount >= MAX_CHAT_PER_IDENTITY) {
      await rotateIdentity();
    }
    yield { type: "end" };
  } finally {
    busy = false;
  }
}

export default { initBrowser, closeBrowser, chatStream };
