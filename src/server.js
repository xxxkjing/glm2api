// glm2api 服务入口
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.js";
import { GuestSessionPool, GuestSession } from "./services/guest-session.js";
import { handleOpenAiRequest } from "./routes/openai-routes.js";

function loadSessionPool() {
  try {
    if (existsSync(config.dataFile)) {
      const data = JSON.parse(readFileSync(config.dataFile, "utf8"));
      return GuestSessionPool.fromJSON(data.sessions ?? []);
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

function checkAuth(request) {
  if (!config.apiKey) {
    return true; // 未配置 key 则开放
  }
  const header = request.headers.authorization ?? "";
  return header === `Bearer ${config.apiKey}`;
}

const sessionPool = loadSessionPool();
console.log(`[glm2api] loaded ${sessionPool.size} guest sessions from ${config.dataFile}`);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (!checkAuth(request)) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    return;
  }

  try {
    const handled = await handleOpenAiRequest(request, response, url, { sessionPool });
    if (!handled) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not Found" } }));
    }
  } catch (error) {
    console.error("request error:", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Internal Server Error" } }));
    }
  }
});

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

export { GuestSession, sessionPool };
