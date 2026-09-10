// X-Sign 签名（chatglm.cn 协议）
// 算法：MD5(`${timestamp}-${nonce}-${SECRET}`)
// 逆向验证：2026-09-09 实测匹配（见 docs/glm-protocol.md）
import { createHash, randomUUID } from "node:crypto";

export const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";

export function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

export function createNonce() {
  return randomUUID().replace(/-/g, "");
}

/**
 * 生成 X-Sign 请求签名 headers
 * @param {string} deviceId 设备 ID
 * @returns {{ timestamp: string, nonce: string, sign: string }}
 */
export function createSignature(deviceId) {
  const timestamp = String(Date.now());
  const nonce = createNonce();
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`);
  return { timestamp, nonce, sign };
}

/**
 * 组装完整请求 headers（带签名）
 */
export function buildSignedHeaders({ token, deviceId, requestId, extra = {} }) {
  const { timestamp, nonce, sign } = createSignature(deviceId);
  return {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "app-name": "chatglm",
    "x-lang": "zh",
    "x-device-id": deviceId,
    "x-app-platform": "pc",
    "x-app-version": "0.0.1",
    "x-app-fr": "default",
    "x-request-id": requestId ?? randomUUID().replace(/-/g, ""),
    "x-exp-groups": "mainchat_rm_fc:exp:add,mainchat_dr:exp:open",
    "x-device-model": "",
    "x-device-brand": "",
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-sign": sign,
    accept: "text/event-stream",
    origin: "https://chatglm.cn",
    referer: "https://chatglm.cn/",
    ...extra
  };
}
