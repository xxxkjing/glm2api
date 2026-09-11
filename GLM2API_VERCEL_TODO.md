# GLM2API_VERCEL — glm2api 适配 Vercel 部署

目标：把 glm2api（零依赖 Node http 网关）适配到 Vercel Serverless，替代易被封的 CF Worker。

参考：deepseek2api-vercel/（api/index.js 适配器 + vercel.json 全路由 + Neon 持久化 + deploy_vercel.py API 直推）

## 计划

- [x] 1. 读现有代码：server.js / openai-routes.js / guest-session.js / rate-limiter.js / glm-chat.js，列出 Vercel 适配点（req/res API、文件存储、静态资源）→ 已读：路由接收标准 Node req/res, openai-routes 自行处理 body, 会话池从 dataFile 加载
- [x] 2. 建 `api/index.js` 入口：Vercel handler 直接复用 createHandler；会话池只从环境变量 GLM2API_SESSIONS 注入（Vercel 无磁盘）
- [x] 3. 拆 `src/server.js`：抽出 `src/handler.js` 的 `createHandler()`（checkAuth + CORS + openai-routes + 静态文件 + 错误处理），server.js 本地加载池/启动/优雅保存；api/index.js Vercel 加载池/导出 handler
- [x] 4. vercel.json：routes 把 /v1/* /admin* /models 全指到 api/index.js（兜底 catch-all）
- [x] 5. 存储适配：Vercel 无状态 → 会话池/限流状态用 GLM2API_SESSIONS 环境变量注入（JSON 字符串）；冷却状态内存级，实例回收丢失（多实例容错）
- [x] 6. 本地验证：`node --test "test/*.test.js"` 40/40 全绿（含新增 vercel-handler.test.js 3 例）
- [x] 7. 测试：npm test 保持全绿 + 新增 Vercel handler 适配测试；scripts/ 真实浏览器脚本拆到 `npm run test:browser` 避免拖垮单元测试
- [x] 8. 文档：README 增加 Vercel 部署章节 + deploy 脚本（参考 deploy_vercel.py）→ 基础版已写（README 含 Vercel 部署段）；deploy_vercel.py 脚本待补 → 视用户决定
- [ ] 9. 部署验证：用 Vercel API 直推部署（需要 glm2api 的 PROJECT_ID；可复用 deepseek2api-vercel 的 TOKEN，新建 project 或用现有）→ **待用户确认：用户 2026-09-11 说"推到 github 上就行"，可能 Vercel 部署不用了**

## 关键点

- Vercel Node Runtime 传入的是标准 Node req/res，createHandler 原样复用
- 浏览器模式（方案 C）在 Vercel 不可用（无真实浏览器），browserChat 传 null
- GLM2API_SESSIONS 环境变量最长 4KB（Vercel env 限制），单 token 足够；多会话可只放 1-2 个优先 token
- 免费版 serverless 10s 超时：流式首 token 一般 2-4s，可接受；非流式聚合有风险，建议客户端用 stream=true