// glm2api 服务管理：start / stop / status / restart
// 用法：
//   node scripts/ctl.js start [--browser] [port]     # 启动（--browser 开启浏览器驱动模式）
//   node scripts/ctl.js stop                          # 停止（按 PID 文件，不误杀）
//   node scripts/ctl.js status                        # 查看状态
//   node scripts/ctl.js restart [--browser] [port]    # 重启
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = join(ROOT, ".glm2api.pid");
const LOG_FILE = join(ROOT, "glm2api.log");

function readPid() {
  try {
    return Number(readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findServerPids(port) {
  try {
    const out = execSync(`ss -tlnp 2>/dev/null | grep ':${port} ' | grep -o 'pid=[0-9]*' | head -3`, { encoding: "utf8" }).trim();
    const pids = out ? out.split("\n").map((l) => Number(l.replace("pid=", ""))).filter(Boolean) : [];
    // 也按命令行特征找（兼容 ss 不可用）
    try {
      const ps = execSync(`ps aux 2>/dev/null | grep '[n]ode src/server.js' | awk '{print $2}'`, { encoding: "utf8" }).trim();
      for (const p of ps.split("\n").map(Number).filter(Boolean)) if (!pids.includes(p)) pids.push(p);
    } catch {}
    return pids;
  } catch {
    return [];
  }
}

function stop(port) {
  const pid = readPid();
  let stopped = 0;
  if (pid && isAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); stopped++; } catch {}
  }
  // 兜底：清理监听该端口/服务特征的残留（不 kill 无关进程）
  const pids = findServerPids(port ?? 3000);
  for (const p of pids) {
    if (p !== pid && isAlive(p)) {
      try { process.kill(p, "SIGTERM"); stopped++; } catch {}
    }
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  return stopped;
}

function start({ browser, port }) {
  const args = ["src/server.js"];
  const env = { ...process.env, PORT: String(port ?? 3000) };
  if (browser) env.GLM2API_BROWSER = "1";
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  // 引导日志：重定向 stdout/stderr 到文件需 detached + fd。简单起见记录启动行。
  writeFileSync(LOG_FILE, `[${new Date().toISOString()}] started pid=${child.pid} port=${port ?? 3000} browser=${browser ? 1 : 0}\n`);
  return child.pid;
}

const cmd = process.argv[2] ?? "status";
const args = process.argv.slice(3);
const portArg = args.find((a) => /^\d+$/.test(a));
const browser = args.includes("--browser");
const port = portArg ? Number(portArg) : null;

switch (cmd) {
  case "start": {
    if (readPid() && isAlive(readPid())) {
      console.log(`already running pid=${readPid()}`);
    } else {
      const pid = start({ browser, port });
      // 等待就绪：轮询日志中 "browser driver ready"（浏览器模式初始化较慢，最多等 40s）
      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < 40000) {
        if (browser) {
          try {
            const log = execSync(`tail -50 ${LOG_FILE} 2>/dev/null`, { encoding: "utf8" });
            if (log.includes("browser driver ready")) { ready = true; break; }
          } catch {}
        } else {
          // 非浏览器模式：/v1/models 通即可
          try {
            const ok = execSync(`curl -s --max-time 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:${port ?? 3000}/v1/models`, { encoding: "utf8" }).trim();
            if (ok === "200") { ready = true; break; }
          } catch {}
        }
        execSync("sleep 1");
      }
      console.log(`started pid=${pid} ${ready ? "ready ✅" : "(still booting — wait or check log)"}`);
    }
    break;
  }
  case "stop": {
    const n = stop(port);
    console.log(n ? `stopped ${n} process(es)` : "nothing to stop");
    break;
  }
  case "restart": {
    const n = stop(port);
    const pid = start({ browser, port });
    console.log(`restarted (stopped ${n}, new pid=${pid})`);
    break;
  }
  case "status":
  default: {
    const pid = readPid();
    console.log(pid && isAlive(pid) ? `running pid=${pid} port=${port ?? 3000}` : "not running");
    console.log(`server processes: ${findServerPids(port).length}`);
  }
}