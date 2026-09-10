# GLM2API_VERCEL — glm2api 适配 Vercel 部署

目标：把 glm2api（零依赖 Node http 网关）适配到 Vercel Serverless，替代易被封的 CF Worker。

参考：deepseek2api-vercel/（api/index.js 适配器 + vercel.json 全路由 + Neon 持久化）

## 计划

- [ ] 1. 读现有代码：server.js / openai-routes.js / guest-session.js / rate-limiter.js / glm-chat.js，列出 Vercel 适配点（req/res API、文件存储、静态资源）
- [ ] 2. 建 `api/index.js` 入口：把 Vercel 的 (req,res) 适配成现有 handler 需要的形态（json/headers.get 补丁，参考 deepseek2api-vercel）
- [ ] 3. 拆 `src/server.js`：把 createServer 部分抽成 `createHandler()` 供 api/index.js 复用；本地运行保持 `node src/server.js`
- [ ] 4. vercel.json：routes 把 /v1/* /admin* /models 全指到 api/index.js
- [ ] 5. 存储适配：Vercel 无状态 → data/app.json 会话池/限流状态需外置（Neon 或内存降级 + 环境变量注入会话）
- [ ] 6. 本地验证：vercel dev 或模拟 handler 跑通 /v1/chat/completions（mock 上游）
- [ ] 7. 测试：npm test 保持全绿 + 新增 Vercel handler 适配测试
- [ ] 8. 文档：README 增加 Vercel 部署章节 + deploy 脚本（参考 deploy_vercel.py）
