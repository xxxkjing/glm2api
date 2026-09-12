// 心跳体检：一键聚合 glm2api 状态
// 用法：node scripts/hb.js
import { execSync } from "node:child_process";

function sh(cmd, fallback = "") {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 25000 }).trim();
  } catch {
    return fallback;
  }
}

console.log("=== 1. 回归测试 ===");
// 注意：必须把输出重定向到文件再读（pipe 到 grep 会改变 node --test 的 spawn 测试行为）
// Node 25 test runner 偶发 IPC 反序列化错误（flaky，非代码红）→ 失败自动重试 1 次
function runTests() {
  sh("node --test --test-concurrency=1 \"test/*.test.js\" > /tmp/hb-test.log 2>&1");
  const out = sh("grep -E '^ℹ (tests|pass|fail)' /tmp/hb-test.log || true", "");
  const fail = out.split("\n").find((l) => l.includes("fail") && !/fail 0/.test(l));
  const ipcFlaky = sh("grep -c 'deserialize' /tmp/hb-test.log || true", "0") !== "0";
  return { out, fail, ipcFlaky };
}
let { out: testOut, fail: failLine, ipcFlaky } = runTests();
let attempts = 1;
// IPC 反序列化错误是环境 flaky（非断言失败），最多重试 2 次；普通断言失败也重试 1 次
while (failLine && attempts < (ipcFlaky ? 3 : 2)) {
  console.log(`  (attempt ${attempts}: ${ipcFlaky ? "IPC flaky" : "fail"} — retrying…)`);
  ({ out: testOut, fail: failLine, ipcFlaky } = runTests());
  attempts++;
}
console.log(testOut || "(empty)");
if (failLine) console.log("⚠️ REGRESSION: " + failLine);

console.log("\n=== 2. git ===");
console.log(sh("git log --oneline -1"));
console.log(sh("git status --short | head -8") || "(worktree clean)");

console.log("\n=== 3. 上游协议巡检（bundle hash）===");
const bundleNow = sh("curl -s --max-time 10 https://chatglm.cn/ | grep -o 'main\\.[a-f0-9]*\\.js' | head -1");
const bundlePrev = sh("cat /tmp/chatglm-bundle.txt 2>/dev/null");
console.log(`now:  ${bundleNow || "fetch failed"}`);
console.log(`prev: ${bundlePrev || "(none, will save)"}`);
if (bundleNow && bundleNow !== bundlePrev) {
  console.log("⚠️ 上游 bundle 变化！检查 glm-protocol.md 适配");
  sh(`echo ${bundleNow} > /tmp/chatglm-bundle.txt`);
} else if (bundleNow) {
  console.log("  上游无变化 ✅");
}

console.log("\n=== 4. QQ 会话状态 ===");
const qq = sh("qwenpaw chats list --agent-id default --channel qq 2>/dev/null | python3 -c \"import json,sys; d=json.load(sys.stdin); [print(s.get('updated_at','?'), '-', s.get('status','?')) for s in d]\"", "qq query failed");
console.log(qq || "(empty)");

console.log("\n=== 5. 阻塞/S4 待办 ===");
console.log(sh("grep -n 'S4 推仓库\\|已阻塞\\|阻塞区' /mnt/workspace/.qwenpaw/workspaces/default/TODO.md | head -5", "grep failed"));