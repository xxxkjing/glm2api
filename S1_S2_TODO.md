# S1-S2 — 工具调用兼容修复

- [x] 摸底：跑 opencode-sim 测试，确认 4/5 红（tool_calls 未解析）
- [ ] 修复非流式路径：`extractToolAwareOutput` 解析 content → tool_calls 数组
- [ ] 修复流式路径：`createToolSieve` 逐块解析 → `delta.tool_calls` 分片
- [ ] finish_reason 有 tool_calls 时设为 `"tool_calls"`
- [ ] 回归：opencode-sim + tool-calls + openai-routes 全绿
- [ ] 追加 opencode 多轮工具结果回传测试
