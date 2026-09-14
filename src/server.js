// glm2api 服务入口（本地运行）
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.js";
import { GuestSessionPool } from "./services/guest-session.js";
import { createHandler } from "./handler.js";

function loadSessionPool() {
  // Vercel 无持久磁盘：支持从环境变量 GLM2API_SESSIONS 注入会话池（JSON 字符串）
  const envRaw = process.env.GLM2API_SESSIONS;
  if (envRaw && envRaw.trim()) {
    try {
      const parsed = JSON.parse(envRaw);
      const pool = GuestSessionPool.fromJSON(
        typeof parsed === "object" && parsed.sessions ? parsed : { sessions: parsed }
      );
      console.log(`[glm2api] loaded ${pool.size} guest sessions from GLM2API_SESSIONS env`);
      return pool;
    } catch (error) {
      console.error("GLM2API_SESSIONS parse failed, falling back to file:", error.message);
    }
  }
  try {
    if (existsSync(config.dataFile)) {
      const data = JSON.parse(readFileSync(config.dataFile, "utf8"));
      // data 是完整池对象 {sessions, cooling}
      return GuestSessionPool.fromJSON(data);
    }
  } catch (error) {
    console.error("load session pool failed:", error.message);
  }
  return new GuestSessionPool();
}

function saveSessionPool(pool) {
  try {
    mkdirSync(dirname(config.dataFile), { recursive: true });
    writeFileSync(config.dataFile, JSON.stringify({ sessions: pool.toJSON() }, null, 2));
  } catch (error) {
    console.error("save session pool failed:", error.message);
  }
}

const sessionPool = loadSessionPool();
console.log(`[glm2api] loaded ${sessionPool.size} guest sessions`);

// 浏览器模式：启动时预初始化浏览器（避免首次请求冷启动超时）
// 失败自动重试（最多 3 次，指数退避），避免一次失败后服务永久 500
let browserChatImpl = null;
let browserInitAttempts = 0;
const BROWSER_MAX_ATTEMPTS = 3;

async function initBrowserWithRetry() {
  const { initBrowser, chatStream } = await import("./services/browser-driver.js");
  while (browserInitAttempts < BROWSER_MAX_ATTEMPTS) {
    browserInitAttempts++;
    try {
      await initBrowser();
      browserChatImpl = chatStream;
      console.log(`[glm2api] browser driver ready (attempt ${browserInitAttempts})`);
      return;
    } catch (error) {
      console.error(`[glm2api] browser driver init failed (${browserInitAttempts}/${BROWSER_MAX_ATTEMPTS}):`, error.message);
      if (browserInitAttempts < BROWSER_MAX_ATTEMPTS) {
        const delay = 5000 * Math.pow(2, browserInitAttempts - 1); // 5s, 10s
        console.log(`[glm2api] retrying browser init in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  console.error(`[glm2api] browser driver init FAILED after ${BROWSER_MAX_ATTEMPTS} attempts — chat will return 500 until restart`);
}

if (config.browserMode) {
  initBrowserWithRetry();
}

// 包装成可直接调用的函数；浏览器未就绪时抛错走 500
function browserChatCallable(options) {
  if (!browserChatImpl) {
    const err = new Error("browser driver not ready");
    throw err;
  }
  return browserChatImpl(options);
}

const handler = createHandler({
  sessionPool,
  browserChat: config.browserMode ? browserChatCallable : null
});
const server = createServer(handler);

server.listen(config.port, () => {
  console.log(`[glm2api] listening on http://127.0.0.1:${config.port}`);
});

// 优雅退出时保存会话池
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    saveSessionPool(sessionPool);
    process.exit(0);
  });
}

export { sessionPool };