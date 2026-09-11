// Vercel Serverless 入口：把 Node req/res 适配给 createHandler
import { config } from "../src/config.js";
import { GuestSessionPool } from "../src/services/guest-session.js";
import { createHandler } from "../src/handler.js";

// Vercel 无持久磁盘：会话池只从环境变量 GLM2API_SESSIONS 注入（JSON 字符串）
// 每实例冷启动时构造一次；限流冷却状态存内存，实例回收即丢失（可接受，靠多实例容错）
function loadSessionPoolFromEnv() {
  const raw = process.env.GLM2API_SESSIONS;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return GuestSessionPool.fromJSON(
        typeof parsed === "object" && parsed.sessions
          ? parsed
          : { sessions: parsed },
      );
    } catch (error) {
      console.error("GLM2API_SESSIONS parse failed:", error.message);
    }
  }
  return new GuestSessionPool();
}

const sessionPool = loadSessionPoolFromEnv();
const handler = createHandler({
  sessionPool,
  browserChat: null, // Vercel 无浏览器，禁用方案 C
});

export default async function vercelHandler(request, response) {
  // Vercel Node.js Runtime 传入的是标准 Node req/res
  // 与本地 server.js 共用一个 handler，路由在 vercel.json 里全指向这里
  await handler(request, response);
}

export { sessionPool, config };