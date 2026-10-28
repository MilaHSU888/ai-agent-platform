"""
WorkHub 本機模型轉接服務（階段 D，最小版本）。

工具容器只連得到這個服務（隔離網路別名 llm-relay），由它把請求轉往核准的模型端點：
- 工具手上只有「工具專用轉接通行碼」，真正的模型金鑰只在本服務的環境變數裡
- 只允許 GET /v1/models 與 POST /v1/chat/completions；上游主機由平台決定，工具無法改送別處
- 用哪個端點、哪個模型由平台決定（routes.json：AI Team 指定，否則平台預設）；工具送來的 model 一律改成平台指定的模型。
  routes.json 依修改時間即時重新載入，AI Team 換模型立即生效，不需重啟工具或本服務（DEC-040）
- 逾時、斷線、上游錯誤都回傳明確錯誤（不會變成成功）
- 每次呼叫記一行中繼資料（工具、模型、狀態、耗時、位元組、token 數），不記錄提示詞或回應內容

不是正式 LLM Proxy：沒有配額、SSO 或完整治理（P1-LLM-001 待定）。
"""
import http.client
import json
import os
import ssl
import sys
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ENDPOINTS = {k: {"url": urlsplit(v["base"].rstrip("/")), "key": v["key"]} for k, v in json.loads(os.environ["RELAY_ENDPOINTS"]).items()}
TOKENS = json.loads(os.environ.get("RELAY_TOKENS", "{}"))              # {token: toolId}
ROUTES_FILE = os.environ.get("RELAY_ROUTES_FILE", "/routes/routes.json")
_routes = {"mtime": None, "data": {"default": None, "tools": {}}}
TIMEOUT = float(os.environ.get("RELAY_TIMEOUT_SECONDS", "125"))
MAX_BODY = int(os.environ.get("RELAY_MAX_BODY_BYTES", str(25 * 1024 * 1024)))
LOG_DIR = os.environ.get("RELAY_LOG_DIR", "/logs")
UA = "WorkHub-LLM-Relay/0.2"
ROUTES = {("GET", "/v1/models"), ("POST", "/v1/chat/completions")}


def route_for(tool):
    """回傳 (端點代號, 模型)；routes.json 有變動就重新讀取（讀取失敗時沿用上一次的設定）"""
    try:
        st = os.stat(ROUTES_FILE)
        key = (st.st_mtime_ns, st.st_ino, st.st_size)  # 平台每次以新檔 rename 取代：inode 必變，兩次變更落在同一時間刻度也不會漏
        if key != _routes["mtime"]:
            with open(ROUTES_FILE, encoding="utf-8") as f:
                _routes["data"] = json.load(f)
            _routes["mtime"] = key
    except (OSError, ValueError) as e:
        print(f"routes reload failed: {e}", file=sys.stderr)
    r = (_routes["data"].get("tools") or {}).get(tool) or _routes["data"].get("default")
    return (r["endpoint"], r["model"]) if r else (None, None)


def log(entry):
    entry["ts"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    try:
        with open(os.path.join(LOG_DIR, f"relay-{datetime.now():%Y%m%d}.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"log write failed: {e}", file=sys.stderr)


class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WorkHubRelay"
    sys_version = ""

    def log_message(self, *args):  # 預設存取日誌含路徑以外資訊，改用自己的中繼資料日誌
        pass

    def _error(self, status, kind, message, meta):
        body = json.dumps({"error": {"type": kind, "message": message}}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        meta.update(status=status, error=kind)
        log(meta)

    def _handle(self, method):
        rid = uuid.uuid4().hex[:12]
        t0 = time.monotonic()
        path = self.path.split("?", 1)[0]
        meta = {"id": rid, "method": method, "path": path, "tool": None}
        if path == "/healthz":
            body = b'{"ok":true}'
            self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        auth = self.headers.get("Authorization", "")
        tool = TOKENS.get(auth[7:].strip()) if auth.startswith("Bearer ") else None
        if not tool:
            return self._error(401, "relay_unauthorized", "轉接通行碼無效：此容器未獲准使用模型", meta)
        meta["tool"] = tool
        if (method, path) not in ROUTES:
            return self._error(404, "relay_route_not_allowed", f"轉接服務不提供 {method} {path}", meta)
        ep_id, model = route_for(tool)
        ep = ENDPOINTS.get(ep_id)
        if not ep or not model:
            return self._error(503, "relay_model_not_configured", "平台尚未為此工具設定模型（請聯絡 AI Team）", meta)
        meta["endpoint"] = ep_id
        meta["model"] = model
        if method == "GET":  # 工具只看得到平台指定給它的模型
            body = json.dumps({"object": "list", "data": [{"id": model, "object": "model", "owned_by": "workhub"}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            meta.update(status=200, ms=int((time.monotonic() - t0) * 1000))
            return log(meta)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._error(413, "relay_body_too_large", f"請求超過 {MAX_BODY // 1024 // 1024} MB", meta)
        body = self.rfile.read(length) if length else b""
        stream = False
        if method == "POST":
            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                return self._error(400, "relay_bad_json", "請求內容不是 JSON", meta)
            meta["requested_model"] = payload.get("model")
            stream = bool(payload.get("stream"))
            meta["stream"] = stream
            payload["model"] = model  # 一律用平台指定的模型
            body = json.dumps(payload, ensure_ascii=False).encode()
        meta["req_bytes"] = len(body)
        up = ep["url"]
        upstream_path = up.path + path[len("/v1"):]
        conn_cls = http.client.HTTPSConnection if up.scheme == "https" else http.client.HTTPConnection
        kwargs = {"context": ssl.create_default_context()} if up.scheme == "https" else {}
        conn = conn_cls(up.hostname, up.port, timeout=TIMEOUT, **kwargs)
        try:
            conn.request(method, upstream_path, body=body or None, headers={
                "Authorization": f"Bearer {ep['key']}", "User-Agent": UA,
                "Content-Type": "application/json", "Accept": self.headers.get("Accept", "application/json")})
            res = conn.getresponse()
        except TimeoutError:
            return self._error(504, "relay_upstream_timeout", f"模型端點超過 {int(TIMEOUT)} 秒沒有回應", meta)
        except OSError as e:
            return self._error(502, "relay_upstream_unreachable", f"連不到模型端點（{type(e).__name__}）", meta)
        meta["upstream_status"] = res.status
        try:
            self.send_response(res.status)
            ctype = res.getheader("Content-Type", "application/json")
            self.send_header("Content-Type", ctype)
            sent = 0
            if stream and res.status == 200:
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    chunk = res.read1(65536) if hasattr(res, "read1") else res.read(65536)
                    if not chunk:
                        break
                    sent += len(chunk)
                    self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            else:
                data = res.read()
                sent = len(data)
                self.send_header("Content-Length", str(sent))
                self.end_headers()
                self.wfile.write(data)
                if "json" in ctype:
                    try:
                        usage = json.loads(data).get("usage") or {}
                        meta["prompt_tokens"] = usage.get("prompt_tokens")
                        meta["completion_tokens"] = usage.get("completion_tokens")
                    except (ValueError, AttributeError):
                        pass
            meta.update(status=res.status, resp_bytes=sent, ms=int((time.monotonic() - t0) * 1000))
            if res.status >= 400:
                meta["error"] = "upstream_error"
            log(meta)
        except TimeoutError:
            meta.update(status=504, error="relay_upstream_timeout_midstream", ms=int((time.monotonic() - t0) * 1000))
            log(meta)
        except (BrokenPipeError, ConnectionResetError):
            meta.update(status=499, error="client_disconnected", ms=int((time.monotonic() - t0) * 1000))
            log(meta)
        finally:
            conn.close()

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


if __name__ == "__main__":
    port = int(os.environ.get("RELAY_PORT", "8080"))
    print(f"WorkHub relay → endpoints={list(ENDPOINTS)} tools={len(TOKENS)} routes={ROUTES_FILE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Relay).serve_forever()
