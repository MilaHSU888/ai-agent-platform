"""入口轉接測試：HTTP 往返、目標未啟動時斷線而非假成功。python3 -m unittest relay/test_tcp_gateway.py"""
import os, socket, subprocess, sys, threading, time, unittest, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = b'tool-ok'; self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

def start_gw(target_port):
    port = free_port()
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'tcp_gateway.py'), '127.0.0.1', str(target_port), str(port)], stdout=subprocess.DEVNULL)
    for _ in range(50):
        try: socket.create_connection(('127.0.0.1', port), timeout=0.2).close(); break
        except OSError: time.sleep(0.1)
    return p, port

class GatewayTest(unittest.TestCase):
    def test_forwards_http(self):
        srv = ThreadingHTTPServer(('127.0.0.1', free_port()), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
        p, port = start_gw(srv.server_port)
        try:
            for _ in range(3):
                self.assertEqual(urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=3).read(), b'tool-ok')
        finally: p.terminate(); p.wait(); srv.shutdown()

    def test_target_down_is_not_success(self):
        p, port = start_gw(free_port())
        try:
            with self.assertRaises(Exception):
                urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=3).read()
        finally: p.terminate(); p.wait()

if __name__ == '__main__':
    unittest.main()
