"""轉接服務自動測試：以本機假上游驗證授權、路由、模型清單、成功／串流、逾時與斷線。執行：python3 -m unittest relay/test_llm_relay.py"""
import json, os, socket, subprocess, sys, tempfile, threading, time, unittest, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
seen = {}

class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        seen["auth"] = self.headers.get("Authorization"); seen["ua"] = self.headers.get("User-Agent"); seen["path"] = self.path
        self._json({"data": [{"id": "good-model"}]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        seen["auth"] = self.headers.get("Authorization"); seen["path"] = self.path
        if body.get("messages", [{}])[0].get("content") == "slow":
            time.sleep(3)
        if body.get("stream"):
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Content-Length", "40"); self.end_headers()
            self.wfile.write(b'data: {"x":1}\n\ndata: {"x":2}\n\ndata: [DONE]\n\n'[:40]); return
        self._json({"choices": [{"message": {"content": "OK"}}], "usage": {"prompt_tokens": 5, "completion_tokens": 1}})
    def _json(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

class RelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.up = ThreadingHTTPServer(("127.0.0.1", free_port()), Upstream)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        cls.logs = tempfile.mkdtemp()
        cls.port = free_port()
        env = dict(os.environ, RELAY_UPSTREAM=f"http://127.0.0.1:{cls.up.server_port}/v1", RELAY_UPSTREAM_KEY="real-upstream-secret-123456",
                   RELAY_TOKENS=json.dumps({"tok-tool-a-0123456789": "tool-a"}), RELAY_MODELS="good-model", RELAY_TIMEOUT_SECONDS="1",
                   RELAY_LOG_DIR=cls.logs, RELAY_PORT=str(cls.port))
        cls.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "llm_relay.py")], env=env, stdout=subprocess.DEVNULL)
        for _ in range(50):
            try: urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/healthz", timeout=0.2); break
            except Exception: time.sleep(0.1)
    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate(); cls.proc.wait(); cls.up.shutdown()

    def call(self, method, path, body=None, token="tok-tool-a-0123456789"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
        try:
            r = urllib.request.urlopen(req, timeout=5); return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def logs_text(self):
        return "".join(open(os.path.join(self.logs, f)).read() for f in os.listdir(self.logs))

    def test_no_or_bad_token_is_rejected(self):
        self.assertEqual(self.call("GET", "/v1/models", token=None)[0], 401)
        self.assertEqual(self.call("GET", "/v1/models", token="wrong")[0], 401)

    def test_only_allowed_routes(self):
        self.assertEqual(self.call("POST", "/v1/embeddings", {"model": "good-model"})[0], 404)
        self.assertEqual(self.call("GET", "/v1/files")[0], 404)

    def test_model_allowlist(self):
        st, body = self.call("POST", "/v1/chat/completions", {"model": "other", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(st, 403); self.assertIn("relay_model_not_allowed", body.decode())

    def test_success_swaps_credentials_and_logs_metadata_only(self):
        st, body = self.call("POST", "/v1/chat/completions", {"model": "good-model", "messages": [{"role": "user", "content": "機密報價內容"}]})
        self.assertEqual(st, 200); self.assertEqual(json.loads(body)["choices"][0]["message"]["content"], "OK")
        self.assertEqual(seen["auth"], "Bearer real-upstream-secret-123456")
        self.assertEqual(seen["path"], "/v1/chat/completions")
        log = self.logs_text()
        self.assertIn('"tool": "tool-a"', log); self.assertIn('"prompt_tokens": 5', log)
        self.assertNotIn("機密報價內容", log); self.assertNotIn("real-upstream-secret", log); self.assertNotIn("tok-tool-a", log)

    def test_models_list_uses_relay_user_agent(self):
        st, _ = self.call("GET", "/v1/models")
        self.assertEqual(st, 200); self.assertTrue(seen["ua"].startswith("WorkHub-LLM-Relay"))

    def test_streaming_passes_through(self):
        st, body = self.call("POST", "/v1/chat/completions", {"model": "good-model", "stream": True, "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(st, 200); self.assertIn(b"data:", body)

    def test_timeout_is_an_error_not_success(self):
        st, body = self.call("POST", "/v1/chat/completions", {"model": "good-model", "messages": [{"role": "user", "content": "slow"}]})
        self.assertEqual(st, 504); self.assertIn("relay_upstream_timeout", body.decode())

class UnreachableTest(unittest.TestCase):
    def test_unreachable_upstream_is_502(self):
        port, logs = free_port(), tempfile.mkdtemp()
        env = dict(os.environ, RELAY_UPSTREAM=f"http://127.0.0.1:{free_port()}/v1", RELAY_UPSTREAM_KEY="k" * 20,
                   RELAY_TOKENS=json.dumps({"tok-b-0123456789": "tool-b"}), RELAY_LOG_DIR=logs, RELAY_PORT=str(port))
        p = subprocess.Popen([sys.executable, os.path.join(HERE, "llm_relay.py")], env=env, stdout=subprocess.DEVNULL)
        try:
            for _ in range(50):
                try: urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=0.2); break
                except Exception: time.sleep(0.1)
            req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/models", headers={"Authorization": "Bearer tok-b-0123456789"})
            with self.assertRaises(urllib.error.HTTPError) as cm: urllib.request.urlopen(req, timeout=5)
            self.assertEqual(cm.exception.code, 502)
        finally:
            p.terminate(); p.wait()

if __name__ == "__main__":
    unittest.main()
