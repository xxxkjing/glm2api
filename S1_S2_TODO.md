# S1-S2 — 工具调用兼容修复（已完成 commit 4c03d6f）

- [x] 摸底：跑 opencode-sim 测试，确认 4/5 红（tool_calls 未解析）
- [x] 清重复 import（extractToolAwareOutput 撞名致语法错）
- [x] 修复非流式路径：`extractToolAwareOutput` 解析 content → tool_calls 数组
- [x] 修复流式路径（会话池+浏览器模式）：`createToolSieve` 逐块解析 → `delta.tool_calls` 分片
- [x] finish_reason 有 tool_calls 时设为 `"tool_calls"`
- [x] 回归：opencode-sim(5) + tool-calls(4) + 全量 49/49 全绿
- [ ] 追加 opencode 多轮工具结果回传测试（需真实链路，当前 IP 被 40012 风控，阻塞）
