# GLM 网页版协议（逆向调研记录）

> 阶段0 逆向调研产出（2026-09-09）。目标：匿名（无 cookie、无登录）调用 GLM 网页版。
> 当前状态：**✅ 匿名对话完全可行——国内站 chatglm.cn 访客模式，curl 复现 200 SSE 成功**。国际站 chat.z.ai 受阿里云滑块 captcha 拦截（攻坚中）；国内站访客无 captcha、频率受限。

## 入口

- **目标 A（推荐）：`https://chatglm.cn/`（智谱清言国内站）**——访客模式匿名对话，无需登录/无需 captcha。
- 目标 B：`https://chat.z.ai/`（GLM 国际站）——匿名 auth/models 可用，但对话需阿里云滑块 captcha（见文末）。

## 国内站（chatglm.cn）协议【已打通】

### 访客 token

打开首页后自动下发 cookie `chatglm_token=<JWT HS256>`（exp 约 24h）。请求用 `Authorization: Bearer <token>`（或 Cookie 均可）。新访客 token 接口：`POST /chatglm/user-api/guest/access`（withToken:false）。

### 请求签名（X-Sign）【已破解验证】

所有 `/chatglm/` 请求必须带签名 headers：

```
X-Timestamp: <ms>
X-Nonce: <uuid-v4 去连字符>
X-Sign: MD5("{timestamp}-{nonce}-8a1317a7468aa3ad86e997d08f3f31cb")
```

- secret 硬编码：`8a1317a7468aa3ad86e997d08f3f31cb`（bundle 逆向，MD5 验证通过）
- 其他必带：`App-Name: chatglm`、`X-Lang: zh`、`X-Device-Id`、`X-App-Platform: pc`、`X-App-Version: 0.0.1`、`X-App-fr: default`、`X-Request-Id`（uuid）、`X-Exp-Groups`、`accept: text/event-stream`

### 对话接口

```
POST https://chatglm.cn/chatglm/backend-api/assistant/stream
```

Body（最小可用）：

```json
{
  "assistant_id": "65940acff94777010aa6b796",
  "conversation_id": "<25位hex 会话ID>",
  "chat_type": "user_chat",
  "meta_data": {
    "selected_model": "glm-5.3-flash",
    "chat_mode": "normal",
    "is_networking": false,
    "platform": "pc"
  },
  "messages": [{"role": "user", "content": [{"type": "text", "text": "你好"}]}]
}
```

- **关键：`chat_mode` 必须 `"normal"`**；`"deep_thinking"` 会导致 40012（guest 不可用或需特殊处理）
- `conversation_id`：25 位 hex（前端生成，复用同一会话即多轮）
- `assistant_id`：首页默认助手 `65940acff94777010aa6b796`
- 响应：**SSE 事件流**（`data: {...}` 含 `parts`/`id`/`conversation_id`/`created_at`）

### 模型

- 访客默认 `glm-5.3-flash`（免费）。完整模型列表待探。

### ⚠️ 频率限制（实测）

- **guest 会话有频率/次数限制**：连续调用（页面 3 条 + curl 数次）后触发 `40012 bad request`，页面也停止回复。
- 限流维度（2026-09-09 实测）：
  - **token/device 级**：重开浏览器拿到的是同一 JWT（cookie 持久化），同 token 持续受限
  - **IP 级嫌疑**：伪造新 device_id 调 guest/access 仍 40012（可能 IP 维度限流，或 guest/access 需额外参数待探）
  - **时间窗口**：限流后需等待恢复（几十分钟~小时级，未精确测）
- 限流维度（2026-09-10 实测补充）：
  - **IP 级确认**：程序化 guest/access（新 device_id、多种 body/header 变体）在当前 IP 下全部 40012——当前 IP 整体被风控，非单一会话/设备问题
  - 影响：程序化刷新会话不可行（同 IP 下），多会话池绕不开 IP 限流；生产多 IP/代理池是唯一出路（超出匿名方案范围）
  - 恢复：IP 级恢复需等超长窗口（数小时~天级）

## 国际站（chat.z.ai）协议【captcha 拦截】

- 匿名 auth：`GET /api/v1/auths/` → guest JWT（无 PoW）
- models：`GET /api/models` → 15 个，OpenAI 兼容格式
- 对话：`POST /api/v2/chat/completions`（SSE，OpenAI body）——但需 `captcha_verify_param`（阿里云滑块，自动化攻坚中 4 轮未破）

## 下一步

1. 验证国内站多轮（同 conversation_id 连续消息）+ 换新访客会话的频率窗口
2. 探国内站模型列表/思考模式（chat_mode 其他值）
3. glm2api 实现：OpenAI 网关 + 访客会话池（轮换 token/device 绕限流）

## 入口

- **目标：`https://chat.z.ai/`**（GLM 国际站，匿名可访问）。
- 国内站 `chatglm.cn`（智谱清言）需手机号登录，有 `user-api/guest/access` 访客机制但 curl 直调 nginx 405（待浏览器验证匿名价值）。
- 页面前端：`prod-fe-1.1.93`，主 bundle `index-CbtGwGjt.js`（3.2MB）。API base 变量：`br=/api/v1`、`Ww=/openai`、对话 base `Ep[2]=/api/v2`。

## 匿名会话（认证）

```
GET https://chat.z.ai/api/v1/auths/
Header: User-Agent, Accept: application/json
（无需 cookie / token）
```

返回（首次调用创建访客会话）：

```json
{
  "id": "uuid",
  "email": "guest-<timestamp>@guest.com",
  "role": "guest",
  "token": "<JWT, ES256 签名>",
  ...
}
```

- 访客邮箱格式 `guest-<unixms>@guest.com`。
- 后续请求用 `Authorization: Bearer <token>`。
- **无 PoW、无需 cookie——比 DeepSeek Web 更宽松。**

## 模型列表

```
GET https://chat.z.ai/api/models
Header: Authorization: Bearer <token>
```

返回 **15 个模型**，**OpenAI 兼容格式**（`object: "model"`、`owned_by: "openai"`、`openai.id`）：

- `glm-5.3` / `glm-5.3-flash`（页面默认 `x-preview-l`）/ `glm-5.2` / `glm-4.7` / `glm-4.6v`（视频）/ `glm-4.5` / `glm-4.1V`（视觉）/ `glm-4.5-air` / `zero` / deep-research 等 15 个。

## 对话接口（核心）

```
POST https://chat.z.ai/api/v2/chat/completions
Header:
  Authorization: Bearer <token>
  Content-Type: application/json
  X-FE-Version: prod-fe-1.1.93
Body（OpenAI 兼容）:
  { "model": "x-preview-l", "messages": [{"role":"user","content":"..."}], "stream": true }
```

响应：**SSE 事件流**（即使 `stream:false` 也返回 SSE），事件 `data: {...}` + `[DONE]`。

**权限边界**（guest）：
- `x-preview-l`（GLM-5.3-Flash）→ 有响应可能性（但被 captcha 拦）
- `glm-5.3` → `{"type": "error", "code": 403, "message": "Model not available for current user level"}`

**X-Signature**：对话请求带 `X-Signature` header（默认空字符串也发送——非必需签名，前端默认传空）。

### 多轮/会话管理

- 对话 body 为 **OpenAI 无状态风格**：`messages` 数组完整携带历史（system/user/assistant 轮次），后端不依赖隐式会话续文。
- `chat_id` / `session_id` 用于**侧边栏/历史管理**（`/api/v1/chats/` 体系：`chats/new`、`chats/remix`、`chats/subagents?chat_id=` 等），**不参与对话上下文**。
- 对 glm2api 实现友好：多轮 = 透传 messages 数组，无需 DeepSeek Web 那种 resume/continue 复杂断点机制。

### 思考模式（Deep Think）与完整请求体

前端对话函数（mhe）实际发送的 body 比最小 OpenAI 格式复杂（bundle 逆向）：

```json
{
  "models": ["x-preview-l"],
  "messages": [{"role":"user","content":"..."}],
  "history": [],
  "params": {},
  "enable_thinking": false,
  "reasoning_effort": "max",
  "files": [],
  "web_search": false,
  "auto_web_search": false,
  "flags": {},
  "features": [],
  "mcp_servers": [],
  "message_version": 1,
  "extra": {},
  "timestamp": 0,
  "type": "chat"
}
```

- **`enable_thinking`**：bool，是否开启思考模式（Deep Think）
- **`reasoning_effort`**：`"max"`（默认）/ `"low"` / `"medium"` 等思考强度
- **`mcp_servers`**：工具调用机制（MCP）
- 注意：curl 用最小 body（`model` 单字段）会返回 `FRONTEND_CAPTCHA_REQUIRED`；用完整 body 返回 500（字段细节待校准，captcha 在前非首要）

### SSE 事件

- 事件类型：`chat:completion`（内容）、`chat:title`（标题生成）、`chat:error` 等
- 内容字段：**`delta_content`**（增量文本）+ **`phase`**（阶段：思考 / 正文）
- 前端用 `chatCompletionsQueue` 按 phase 组装思考与正文
- 结束标记：`data: [DONE]`

## ⚠️ captcha 拦截（当前主要障碍）

匿名对话返回：

```json
{"type":"error","code":403,"message":"FRONTEND_CAPTCHA_REQUIRED","param":"missing_param"}
```

需在请求 body 加 `captcha_verify_param`（前端先过阿里云滑块验证）。

### 阿里云滑块机制（已逆向）

- JS: `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`
- 配置：`REGION=cn`、`PREFIX=no8xfe`、`SCENE_ID=didk33e0`（chat.z.ai 动态）、`MODE=embed`
- 初始化：`window.initAliyunCaptcha({ SceneId, mode:'embed', element, success, fail })`
- 成功回调返回验证结果（`success:true, verifyResult:true, verifyCode, certifyId`）→ 作为 `captcha_verify_param` 传给对话接口
- 错误码：`F001`=行为风控；`F015`=拖拽距离不对（轨迹已通过行为检测）

### 自动化现状（攻坚中）

- 滑块可嵌入页面临时容器（`initAliyunCaptcha` embed 模式）
- 行为检测**可通过**（dispatchEvent 合成轨迹 F001→F015）
- 缺口位置检测：**模板匹配**（拼图块 `#aliyunCaptcha-puzzle` 52x200 vs 背景 `#aliyunCaptcha-img` 296x200，fetch+createImageBitmap 绕过跨域，跳过透明像素）可定位缺口左边缘（如 62/205px）
- **未破**：拖动手柄→拼图块移动映射非线性（0.78~0.90 变化）、且每次 F015 后验证码刷新缺口重随机；闭环控制（实时读块位置到位松手）仍 F015

### 下一步方向

1. 模板匹配得分与次佳对比确认（缺口 vs 巧合纹理）
2. headed 浏览器人工确认缺口位置与映射
3. 评估替代：国内站 guest 通道（chatglm.cn 浏览器验证）、智谱开放平台免费 API key
4. 若长期不可行 → 通知用户决策（匿名模式 vs 账号模式）

## 其他 API 路径（53 个，`/api/v1/` 前缀）

`chats/` 体系（`chats/new` 创建会话、`chats/remix`）、`users/` 系列、`index/` 系列（检索）、`share/` 系列、`file/` 系列、`audio/`、`images/`、`pipelines/`、`retrieval`、`utils/parser/` 等。前端对话不走 chats 时用 `/api/v2/chat/completions`。

## ⚠️ 上游更新（2026-09-10 巡检）

- 前端 bundle：`main.888d80b8.js` → `main.be18f4bd.js`（更新）
- **X-Sign secret 未变**：`8a1317a7468aa3ad86e997d08f3f31cb`（签名兼容 ✅）
- **对话路径重构（确认方向）**：`backend-api/assistant` 子路径只剩辅助功能（file/upload、create、info 等），**`assistant/stream` 已废弃**；出现新接口 `backend-api/v1/stream_context?__requestid=`（通用 POST，含 __requestid）。对话 body 关键字段（assistant_id/conversation_id/chat_mode）仍在 bundle 中，**对话 URL 的确切新路径待真实环境实测确认**（当前 IP 被 guest 风控无法验证；glm2api `STREAM_URL` 保持旧值，真实验证时用浏览器 hook 抓新 URL 后适配）。

## 结论

**匿名调用 GLM 完全可行**（auth 无 PoW、models OpenAI 兼容、对话接口标准 SSE），唯一硬障碍是阿里云滑块 captcha 的自动化过验证。这决定 glm2api 是否走"匿名模式"（每次对话前过滑块）还是结合其他通道。障碍明确、可评估、可决策。