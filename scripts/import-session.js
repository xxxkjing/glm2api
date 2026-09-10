#!/usr/bin/env node
// 从浏览器 cookie 导入访客会话到会话池
// 用法：
//   node scripts/import-session.js "<cookie字符串或chatglm_token值>"
// 例：
//   node scripts/import-session.js "chatglm_token=eyJ...; acw_tc=..."
//   node scripts/import-session.js "eyJhbGciOiJIUzI1NiIs..."
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GuestSession, GuestSessionPool } from "../src/services/guest-session.js";

const dataFile = process.env.GLM2API_DATA_FILE ?? resolve("./data/glm2api.json");
const raw = process.argv[2];

if (!raw) {
  console.error(`用法: node scripts/import-session.js "<cookie或token>"`);
  console.error(`从浏览器复制: 打开 chatglm.cn → F12 → Application → Cookies → chatglm_token 的值`);
  process.exit(1);
}

// 提取 token：支持 "chatglm_token=xxx; ..." 或裸 JWT
let token = raw.trim();
const match = token.match(/chatglm_token=([^;]+)/);
if (match) {
  token = match[1];
}
if (!token.startsWith("eyJ")) {
  console.error("看起来不是有效的 JWT（应以 eyJ 开头）。");
  process.exit(1);
}

// 读现有池（若存在）
let pool = new GuestSessionPool();
try {
  if (existsSync(dataFile)) {
    pool = GuestSessionPool.fromJSON(JSON.parse(readFileSync(dataFile, "utf8")));
  }
} catch (error) {
  console.warn(`读取现有池失败（${error.message}），新建`);
}

// 去重（token 相同跳过）
if (pool.sessions.some((s) => s.token === token)) {
  console.log("该 token 已在会话池中，跳过。");
  process.exit(0);
}

const session = new GuestSession({ token });
pool.add(session);

mkdirSync(dirname(dataFile), { recursive: true });
writeFileSync(dataFile, JSON.stringify(pool.toJSON(), null, 2));
console.log(`✅ 已导入访客会话（共 ${pool.size} 个）`);
console.log(`   数据文件: ${dataFile}`);
console.log(`   下一步: npm start 然后 OpenAI 兼容调用`);
