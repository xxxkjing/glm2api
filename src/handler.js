// glm2api 可复用 HTTP handler —— 本地 server.js 和 Vercel api/index.js 共用
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

import { config } from "./config.js";
import { handleOpenAiRequest } from "./routes/openai-routes.js";

export function checkAuth(request) {
  if (!config.apiKey) {
    return true; // 未配置 key 则开放
  }
  const header = request.headers.authorization ?? "";
  return header === `Bearer ${config.apiKey}`;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

// 简版根页面：Render/Vercel 部署后打开域名不 404，给个引导
function renderRootPage() {
  const port = config.port ?? 3000;
  const hasKey = Boolean(config.apiKey);
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>glm2api · running</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 640px; padding: 0 1rem; background: #111; color: #eee; }
    h1 { font-size: 1.4rem; }
    code { background: #222; padding: 2px 6px; border-radius: 4px; }
    a { color: #6ab0ff; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>glm2api 运行中 ✅</h1>
  <div class="card">
    <p>GLM 网页版 → OpenAI 兼容网关</p>
    <p>服务端口 <code>${port}</code> · API Key ${hasKey ? "已启用（需要 Bearer 鉴权）" : "未启用（开放）"}</p>
  </div>
  <div class="card">
    <p>· 模型列表 <code>GET /v1/models</code></p>
    <p>· 对话 <code>POST /v1/chat/completions</code></p>
    <p>· 管理页 <a href="/admin">/admin</a></p>
  </div>
  <p style="color:#777;font-size:0.85rem">匿名 GLM 网页通道，仅供学习研究 · 上游限流时请合理使用</p>
</body>
</html>`;
}

function serveStatic(request, response, pathname) {
  try {
    const base = join(process.cwd(), "public");
    let file = join(base, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(base)) {
      return false;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      return false;
    }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
}

export function createHandler({ sessionPool, browserChat = null }) {
  return async function handler(request, response) {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    if (!checkAuth(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Invalid API key" } }),
      );
      return;
    }

    // 安全默认：未配置 API key 时，管理端路由仅允许本机访问（公网部署者通常应配 key）
    const isAdminPath = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
    if (isAdminPath && !config.apiKey) {
      const remote = (request.socket?.remoteAddress ?? request.headers["x-forwarded-for"] ?? "").toString();
      const local =
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1" ||
        remote.startsWith("10.") ||
        remote.startsWith("192.168.") ||
        remote.startsWith("172.16.") ||
        remote.startsWith("172.17.") ||
        remote.startsWith("172.18.") ||
        remote.startsWith("172.19.") ||
        remote.startsWith("172.2") ||
        remote.startsWith("172.30.") ||
        remote.startsWith("172.31.");
      if (!local) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Admin requires API key on non-local access", type: "invalid_request_error", code: "admin_requires_key" },
          }),
        );
        return;
      }
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers":
          "content-type, authorization, x-proxy-account-id",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS"
      });
      response.end();
      return;
    }

    try {
      response.setHeader("access-control-allow-origin", "*");

      const handled = await handleOpenAiRequest(request, response, url, {
        sessionPool,
        browserChat: typeof browserChat === "function" ? browserChat : null
      });
      if (!handled) {
        // 根路径：返回内置状态页（Render/Vercel 打开域名不 404）
        if (url.pathname === "/" || url.pathname === "/index.html") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(renderRootPage());
          return;
        }
        if (!serveStatic(request, response, url.pathname)) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Not Found" } }));
        }
      }
    } catch (error) {
      console.error("request error:", error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "Internal Server Error" } }),
        );
      } else {
        response.destroy(error);
      }
    }
  };
}