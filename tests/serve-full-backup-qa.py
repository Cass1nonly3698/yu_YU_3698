from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import os
import subprocess
import mimetypes
import urllib.parse

repo = Path(__file__).resolve().parents[1]
out = Path(os.environ.get('RP_HUB_QA_OUTPUT', str(repo / 'test-results')))
legacy = subprocess.check_output(['git','show','ab7500d:assets/js/full-backup.js'], cwd=repo)
out.mkdir(exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        file = (repo / path.lstrip('/')).resolve()
        if path == '/ab7500d-full-backup.js':
            self.send_response(200); self.send_header('Content-Type','application/javascript'); self.send_header('Content-Length',str(len(legacy))); self.end_headers(); self.wfile.write(legacy); return
        if not file.is_relative_to(repo) or not file.is_file():
            self.send_error(404); return
        data = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript' if path.endswith('.js') else mimetypes.guess_type(file)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        if self.path not in ['/qa-progress', '/qa-result']:
            self.send_error(404); return
        length = int(self.headers.get('Content-Length', '0'))
        if length > 16384:
            self.send_error(413); return
        data = json.loads(self.rfile.read(length))
        assert data.get('syntheticOnly') is True and data['payloadMiB'] in [20, 30, 50]
        engine = 'webkit' if 'AppleWebKit' in data.get('userAgent', '') and 'Chrome' not in data['userAgent'] else 'chromium'
        name = f"{engine}-large-{data['payloadMiB']}{'-progress' if self.path == '/qa-progress' else ''}.json"
        (out / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'engine': engine, 'MiB': data['payloadMiB'], 'stage': data.get('stage'), 'pass': data.get('pass')}, ensure_ascii=False), flush=True)
        self.send_response(204); self.end_headers()
    def log_message(self, *args): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
(out / 'local-qa-url.txt').write_text(f'http://127.0.0.1:{server.server_port}/tests/full-backup-large.html\n')
print(f'http://127.0.0.1:{server.server_port}/tests/full-backup-large.html', flush=True)
server.serve_forever()
