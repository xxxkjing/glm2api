// 滑动窗口限流器：控制每会话调用频率，避免触发上游风控（40012）
export class SlidingWindowLimiter {
  /**
   * @param {object} options
   * @param {number} [options.windowMs] 窗口毫秒
   * @param {number} [options.max] 窗口内最大调用数
   * @param {number} [options.minIntervalMs] 单次最小间隔
   */
  constructor({ windowMs = 60_000, max = 10, minIntervalMs = 2_000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.minIntervalMs = minIntervalMs;
    this.hits = new Map(); // key -> number[] 时间戳数组
  }

  /** 检查是否允许调用（不改变状态） */
  canCall(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      return false;
    }
    if (list.length > 0 && now - list[list.length - 1] < this.minIntervalMs) {
      return false;
    }
    return true;
  }

  /** 记录一次调用 */
  record(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
  }

  /** 还有多久才能允许（毫秒；0=现在可调） */
  waitMs(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      return this.windowMs - (now - list[0]);
    }
    if (list.length > 0) {
      const gap = this.minIntervalMs - (now - list[list.length - 1]);
      if (gap > 0) {
        return gap;
      }
    }
    return 0;
  }
}