# glm2api

GLM 网页版 → OpenAI 兼容网关（匿名模式，无需登录、无需 cookie）。

逆向 chatglm.cn（智谱清言）访客协议实现：匿名对话免费调用 GLM-5.3-Flash 等模型，对外暴露 OpenAI 兼容接口（`/v1/models`、`/v1/chat/completions`）。

> ⚠️ 仅供学习研究。上游免费通道有频率限制，请合理使用。

## 快速开始

```bash
# 1. 准备访客会话（从浏览器 cookie 导入）
#    打开 https://chatglm.cn 匿名聊天后，把 cookie 里的 chatglm_token 写入 data/glm2api.json：
#    {"sessions": [{"token": "<chatglm_token>", "deviceId": "<可选>"}]}

# 2. 启动
npm start   # 默认 http://127.0.0.1:3000

# 3. OpenAI 兼容调用
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"你好"}]}'
```

## 接入示例

### curl

```bash
# 非流式
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"写一首诗"}]}'

# 流式
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","stream":true,"messages":[{"role":"user","content":"写一首诗"}]}'

# 工具调用（OpenAI tools 格式）
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"查询杭州天气"}],
       "tools":[{"type":"function","function":{"name":"get_weather","description":"查询天气",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}'
```

### opencode（agent 客户端）

```bash
# ~/.config/opencode/opencode.json 或项目 opencode.json
{
  "provider": {
    "glm": {
      "type": "openai",
      "name": "GLM (glm2api)",
      "baseURL": "http://127.0.0.1:3000/v1",
      "apiKey": "any",
      "models": { "glm-5.3-flash": { "name": "GLM-5.3-Flash" } }
    }
  },
  "model": "glm"
}
# 启动：opencode --provider glm
```

### AI SDK（TypeScript）

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const glm = createOpenAI({ baseURL: "http://127.0.0.1:3000/v1", apiKey: "any" });

const { text } = await generateText({
  model: glm("glm-5.3-flash"),
  prompt: "用一句话介绍 GLM"
});
console.log(text);
```

## 服务管理（scripts/ctl.js）

```bash
node scripts/ctl.js start [--browser] [port]   # 启动（--browser 开浏览器驱动模式）
node scripts/ctl.js stop [port]                # 停止（PID 文件 + 端口进程清理）
node scripts/ctl.js status                     # 查看状态
node scripts/ctl.js restart [--browser] [port] # 重启
```

## 工具脚本（scripts/）

```bash
node scripts/import-session.js <chatglm_token>   # 手动导入访客 token 到会话池
node scripts/auto-fetch-token.js [--quiet]       # Playwright 自动抓 chatglm.cn 匿名 token 并注入会话池
node scripts/hb.js                               # 心跳体检：回归测试/git/上游 bundle/QQ 一键聚合
node scripts/ctl.js start|stop|status|restart    # 服务管理（见上节）
```

## 管理页

`GET http://127.0.0.1:3000/admin` 提供管理状态页：

- **会话池**：总数/可用/冷却统计 + 明细表（设备/角色/状态/过期）+ 导入（粘贴 token）/ 删除
- **使用统计**：总请求/成功/失败/限流 + 按模型聚合
- **配置**：端口/默认模型/API key 状态/数据文件

对应 JSON API：`/admin/api/status`、`/admin/api/sessions`（POST 导入 / DELETE 删除）。

## 浏览器模式（GLM2API_BROWSER=1，方案 C）

当上游对 API 直调风控（40012）时，可用**浏览器驱动模式**绕过：
对话经 Playwright 控制的真实浏览器页面（chatglm.cn 匿名访客）发出，
身份/会话/额度由页面自动管理，网关只负责把页面回复增量转发为 OpenAI SSE。

```bash
# 需要系统 chromium（/usr/bin/chromium，可用 CHROMIUM_PATH 覆盖）
npm i playwright-core
GLM2API_BROWSER=1 node src/server.js
```

特点：
- 启动时预初始化浏览器（避免首次请求冷启动超时）
- 流式/非流式均支持；自动跳过模型思考过程（只转发正文）
- 单浏览器串行处理（busy 时 409）；思考模式回复慢（~10-30s），请调大客户端超时
- 会话池（token 模式）与浏览器模式互斥，二选一

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000` | 监听端口 |
| `GLM2API_KEY` | 空 | 设置后要求 `Authorization: Bearer <key>`（未设置则开放） |
| `GLM2API_DATA_FILE` | `./data/glm2api.json` | 访客会话池持久化文件 |
| `GLM2API_MODEL` | `glm-5.3-flash` | 默认模型 |

## Vercel 部署

glm2api 可部署到 Vercel Serverless（替代易被封的 CF Worker）。

**适配结构**：
- `src/handler.js` — `createHandler()`（鉴权 + CORS + OpenAI 路由 + 静态文件），本地与 Vercel 共用
- `api/index.js` — Vercel Serverless 入口（从环境变量注入会话池）
- `vercel.json` — 全部路由指向 api/index.js

**部署步骤**：

1. 准备一个可用访客 token（从浏览器匿名对话 cookie 取 `chatglm_token`）
2. Vercel 项目设置环境变量：
   - `GLM2API_SESSIONS` = `{"sessions":[{"token":"<chatglm_token>"}]}`（JSON 字符串，单 token 即可）
   - `GLM2API_KEY` = 你的 API Key（可选，设置后要求 Bearer 鉴权）
3. 推送代码到 Git 仓库，Vercel 自动部署；或运行 `python3 deploy_vercel.py` 走 API 直推（需 PROJECT_ID）

**注意**：
- Vercel 无持久磁盘：会话池/限流冷却只存内存，实例回收即丢失（多实例容错，token 失效需更新环境变量）
- 浏览器模式（方案 C）在 Vercel 不可用（无真实浏览器）
- 免费版 serverless 10s 超时：建议客户端用 `stream=true`（首 token 2-4s），非流式聚合有超时风险
- 环境变量限制：Vercel env 单值最长 4KB，放 1-2 个优先 token 足够

## 架构

```
OpenAI 客户端 → /v1/chat/completions
                     ↓
           openai-routes.js（流式/非流式转发）
                     ↓
             glm-chat.js（上游 SSE 调用）
                     ↓
            guest-session.js（会话池轮换/冷却）
                     ↓
      chatglm.cn backend-api/assistant/stream（匿名）
```

模块：

- `src/services/glm-sign.js` — X-Sign 签名（MD5(timestamp-nonce-secret)，协议逆向自上游）
- `src/services/guest-session.js` — 访客会话池（过期检测 / 轮换 / 限流冷却 30min 自动恢复 / JSON 持久化）
- `src/services/glm-chat.js` — 上游对话客户端（SSE 解析 / 思考内容提取 / 消息归一化）
- `src/services/rate-limiter.js` — 滑动窗口限流（防触发上游风控）
- `src/routes/openai-routes.js` — OpenAI 兼容路由（models + chat/completions）
- `src/server.js` — HTTP 服务 + API key 鉴权 + 会话池加载/保存

## 协议

见 `docs/glm-protocol.md`（匿名认证 / X-Sign / 对话接口 / 限流边界完整逆向记录）。

## 限流与风控（重要）

- guest 会话有频率限制：连续调用触发上游 `40012`，会话进入冷却（30 分钟自动恢复）
- 访客身份绑定设备指纹，简单清 cookie 无法刷新
- 多轮为无状态（messages 携带历史），无需会话上下文管理
- 生产使用建议：多会话池 + 频率控制 + 优雅降级

## 测试

```bash
npm test   # 26 个用例（签名/会话/SSE 解析/限流/网关）
```
