// 验证身份轮换：3 次对话后应自动轮换新身份
import { initBrowser, chatStream, closeBrowser } from "../src/services/browser-driver.js";

async function chatOnce(text) {
  const chunks = [];
  for await (const ev of chatStream({ text })) {
    if (ev.type === "content") chunks.push(ev.content);
    if (ev.type === "error") throw new Error(ev.error.message);
  }
  return chunks.join("");
}

const page = await initBrowser();
const getIdentity = () => page.evaluate(() => (localStorage.getItem("chatglm-deid") || "").slice(0, 8));
console.log("[test] 初始身份:", await getIdentity());
for (let i = 1; i <= 4; i++) {
  const reply = await chatOnce(`第${i}次测试：回复ok`);
  console.log(`[test] 第${i}次: ${reply.length > 30 ? reply.slice(0, 30) + "..." : reply}`);
  console.log(`[test]   身份: ${await getIdentity()}`);
}
await closeBrowser();
console.log("[test] PASS（若第3次后身份变化）");
