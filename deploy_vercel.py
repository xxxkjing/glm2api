#!/usr/bin/env python3
"""Deploy glm2api to Vercel via API (files mode, no GitHub dependency).

用法：
  1. 设置环境变量（或直接改下方常量）：
     VERCEL_TOKEN=<vcp_xxx>
     GLM2API_PROJECT_ID=prj_xxx
  2. python3 deploy_vercel.py

会收集项目文件（跳过 node_modules/.git/data），创建 production 部署并轮询状态。
"""
import base64, json, os, sys, time, urllib.request, urllib.error

TOKEN = os.environ.get("VERCEL_TOKEN", "vcp_4OGT1wcuE5z8Kxigs0SXdJ7csnUg5Yy7ijpFh5ReXyf8WOAC8n2mVBcK")
API = "https://api.vercel.com"
PROJECT_ID = os.environ.get("GLM2API_PROJECT_ID", "")
ROOT = os.path.dirname(os.path.abspath(__file__))

if not PROJECT_ID:
    print("ERROR: GLM2API_PROJECT_ID not set (or edit deploy_vercel.py)")
    sys.exit(1)


def api_request(method, path, body=None):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        try:
            return {"error": json.loads(err)}
        except Exception:
            return {"error": {"message": err[:500]}}


def collect_files():
    files = []
    skip_dirs = ["node_modules", ".git", "__pycache__", "data", ".vercel"]
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, ROOT)
            if rel.startswith(".") or rel.endswith((".bak", ".bak2", ".zip")):
                continue
            if "__pycache__" in rel:
                continue
            try:
                with open(fp, "rb") as f:
                    files.append({
                        "file": rel,
                        "data": base64.b64encode(f.read()).decode(),
                        "encoding": "base64",
                    })
            except OSError:
                continue
    return files


def main():
    files = collect_files()
    print(f"Collecting {len(files)} files...")
    body = {
        "name": "glm2api",
        "project": PROJECT_ID,
        "target": "production",
        "files": files,
        "projectSettings": {"framework": "node"},
    }
    print("Creating deployment...")
    dep = api_request("POST", "/v13/deployments", body)
    if "error" in dep:
        print("ERROR:", dep["error"])
        return 1
    dep_id = dep.get("id")
    print("Deployment id:", dep_id)
    print("URL:", dep.get("url"))
    print("State:", dep.get("readyState") or dep.get("state"))
    for i in range(30):
        status = api_request("GET", f"/v13/deployments/{dep_id}")
        rs = status.get("readyState") or status.get("state")
        print(f"  [{i+1}] {rs}")
        if rs in ("READY", "ERROR", "BLOCKED", "CANCELED"):
            if rs == "READY":
                print("alias:", status.get("alias"))
                print("aliasAssigned:", status.get("aliasAssigned"))
            break
        time.sleep(10)
    return 0


if __name__ == "__main__":
    sys.exit(main())