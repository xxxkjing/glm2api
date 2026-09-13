// 访客会话管理（chatglm.cn 匿名模式）
// token 从浏览器 cookie 导入（chatglm_token JWT），或由 guest/access 动态获取（待验证）
import { randomUUID } from "node:crypto";

const DEFAULT_EXPIRES_IN_MS = 24 * 60 * 60 * 1000; // JWT exp 约 24h

/**
 * 解码 JWT payload（不校验签名）
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    const json = Buffer.from(part, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export class GuestSession {
  constructor({ token, deviceId, uid = null }) {
    if (!token) {
      throw new Error("GuestSession requires token");
    }
    this.token = token;
    this.deviceId = deviceId ?? randomUUID().replace(/-/g, "").slice(0, 32);
    this.uid = uid;

    const payload = decodeJwtPayload(token);
    this.expiresAt = payload?.exp ? payload.exp * 1000 : Date.now() + DEFAULT_EXPIRES_IN_MS;
    this.role = payload?.is_guest === true ? "guest" : "unknown";
  }

  isExpired(now = Date.now()) {
    return now >= this.expiresAt;
  }

  toJSON() {
    return {
      token: this.token,
      deviceId: this.deviceId,
      uid: this.uid,
      expiresAt: this.expiresAt,
      role: this.role
    };
  }

  static fromJSON(data) {
    if (!data?.token) {
      return null;
    }
    const session = new GuestSession({
      token: data.token,
      deviceId: data.deviceId,
      uid: data.uid
    });
    return session;
  }
}

/**
 * 访客会话池：管理多个会话，支持轮换 + 冷却恢复
 */
export class GuestSessionPool {
  constructor(sessions = []) {
    this.sessions = sessions;
    this.cooling = new Map(); // token -> coolingUntil(ms)
  }

  add(session) {
    this.sessions.push(session);
    return session;
  }

  /** 取一个未过期且未冷却的会话（简单轮转）；无可用返回 null */
  take(now = Date.now()) {
    // 恢复到期冷却会话
    for (const [token, until] of this.cooling) {
      if (now >= until) {
        this.cooling.delete(token);
      }
    }
    const usable = this.sessions.filter((s) => !s.isExpired(now) && !this.cooling.has(s.token));
    if (!usable.length) {
      return null;
    }
    // 轮转：把第一个可用会话移到末尾（保留冷却中的会话在原池）
    const session = usable[0];
    this.sessions = [...this.sessions.filter((s) => s !== session), session];
    return session;
  }

  /** 标记限流：进入冷却（COOLING_MS 后自动恢复），不影响池内其他会话 */
  markRateLimited(token, coolingMs = 30 * 60 * 1000) {
    this.cooling.set(token, Date.now() + coolingMs);
  }

  get size() {
    return this.sessions.length;
  }

  availableSize(now = Date.now()) {
    return this.sessions.filter((s) => {
      if (s.isExpired(now)) {
        return false;
      }
      const until = this.cooling.get(s.token);
      // 冷却中且未到期 → 不可用
      return !(until !== undefined && until > now);
    }).length;
  }

  toJSON() {
    return {
      sessions: this.sessions.map((s) => s.toJSON()),
      cooling: Array.from(this.cooling.entries()).map(([t, until]) => ({ token: t, until }))
    };
  }

  static fromJSON(data) {
    // 兼容两种数据形态：
    //   A. { sessions: [...], cooling: [...] }            （本服务保存格式）
    //   B. { sessions: { sessions: [...], cooling: [...] } } （部分写入端会双重嵌套）
    const inner = data && !Array.isArray(data.sessions) && typeof data.sessions === "object" && Array.isArray(data.sessions.sessions)
      ? data.sessions
      : data;
    const pool = new GuestSessionPool((inner?.sessions ?? []).map((d) => GuestSession.fromJSON(d)).filter(Boolean));
    if (inner?.cooling) {
      for (const c of inner.cooling) {
        if (c?.token && c?.until) {
          pool.cooling.set(c.token, c.until);
        }
      }
    }
    return pool;
  }
}
