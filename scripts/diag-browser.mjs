// 诊断：headless 下发送 + 容器读取
import { initBrowser, closeBrowser } from "../src/services/browser-driver.js";

const page = await initBrowser();
console.log("[diag] browser ready");
await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  if (!ta) return "no ta";
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "你好");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return "filled";
}).then(r => console.log("[diag] fill:", r));
await page.keyboard.press("Enter");
console.log("[diag] Enter pressed");
await page.waitForTimeout(12000);
const probe = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  const c = document.querySelector(".conversation-inner");
  return {
    inputValue: ta ? ta.value.slice(0, 20) : "no-ta",
    containerText: c ? (c.innerText || "").slice(0, 150) : "no-container",
    bodyHasUser: document.body.innerText.includes("你好")
  };
});
console.log("[diag] probe:", JSON.stringify(probe, null, 1));
await closeBrowser();
process.exit(0);
