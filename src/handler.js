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
      response.end(JSON.stringify({ error: { message: "Invalid API key" } }));
      return;
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