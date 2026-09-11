// 验证 browser-driver：真实浏览器匿名对话 + 流式捕获
import { initBrowser, chatStream, closeBrowser } from "../src/services/browser-driver.js";

async function main() {
  const msg = process.argv[2] || "用一句话介绍你自己";
  console.log("[test] init browser...");
  await initBrowser();
  console.log("[test] sending:", msg);
  const chunks = [];
  for await (const ev of chatStream({ text: msg })) {
    if (ev.type === "content") {
      chunks.push(ev.content);
      process.stdout.write(ev.content);
    } else if (ev.type === "error") {
      console.error("\n[test] ERROR:", ev.error.message);
      process.exit(1);
    } else if (ev.type === "end") {
      console.log("\n[test] DONE, total", chunks.join("").length, "chars");
    }
  }
  await closeBrowser();
  if (chunks.join("").length < 5) {
    console.error("[test] FAIL: reply too short");
    process.exit(1);
  }
  console.log("[test] PASS");
}

main().catch((e) => {
  console.error("[test] FAIL:", e.message);
  process.exit(1);
});
