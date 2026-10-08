"""Exercise the real containerized Patchright/Chrome service against a local fixture.

No internet access, external services, or additional test dependencies required.
"""
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = "http://127.0.0.1:17333"
PAGE = """<!doctype html>
<html><head><title>Browser fixture</title></head><body>
<main>
<h1>Local browser integration fixture</h1>
<input id="name" aria-label="Your name">
<button id="save">Save</button>
<p id="result"></p>
<a href="/next">Navigate to next page</a>
</main>
<script>
if (document.cookie.includes('visited=1')) {
  document.querySelector('#result').textContent = 'Returning session';
}
document.querySelector('#save').addEventListener('click', () => {
  document.cookie = 'visited=1; Path=/; SameSite=Lax';
  document.querySelector('#result').textContent =
    'Saved: ' + document.querySelector('#name').value;
});
</script>
</body></html>"""


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/test":
            body = PAGE
        elif self.path == "/next":
            body = "<html><title>Next page</title><main><h1>Navigation succeeded</h1></main></html>"
        else:
            self.send_error(404)
            return
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def call(path, body=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        API + path,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def require(condition, description):
    if not condition:
        raise AssertionError(description)


def run():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    cid = None
    try:
        # GitHub-hosted Linux runners support host networking. It keeps both
        # the test fixture and browser private to the ephemeral CI host.
        cid = subprocess.check_output([
            "docker", "run", "--rm", "-d", "--network", "host",
            "--tmpfs", "/tmp:size=256m,mode=1777",
            "--tmpfs", "/contexts:size=256m,mode=1777",
            "-e", "PORT=17333", "-e", "HOST=127.0.0.1",
            "-e", "HOME=/tmp", "-e", "XDG_CONFIG_HOME=/tmp/.config",
            "-e", "XDG_CACHE_HOME=/tmp/.cache", "-e", "CONTEXTS_DIR=/contexts",
            "-e", "BROWSER_WARMUP_ON_START=1",
            "stealth-browser:ci",
        ], text=True).strip()

        deadline = time.monotonic() + 40
        while True:
            try:
                health = call("/health", timeout=2)
                if health["warmup_succeeded"]:
                    break
                if health["warmup_attempted"] and health["warmup_error"]:
                    raise AssertionError(f"Chrome warmup failed: {health['warmup_error']}")
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            require(time.monotonic() < deadline, "containerized Chrome did not become ready")
            time.sleep(0.5)

        url = f"http://127.0.0.1:{port}/test"
        first = call("/scrape", {
            "url": url,
            "actions": [
                {"type": "wait_for", "selector": "#name"},
                {"type": "type", "selector": "#name", "value": "Patchright CI"},
                {"type": "click", "selector": "#save"},
            ],
        })
        require(first.get("success"), "first scrape failed")
        require(first.get("title") == "Browser fixture", "page title not extracted")
        require("Saved: Patchright CI" in first.get("text", ""), "typing/clicking failed")
        require(any(link["href"].endswith("/next") for link in first.get("links", [])),
                "DOM link extraction failed")

        session = call("/scrape", {"url": url})
        require("Returning session" in session.get("text", ""),
                "persistent Chrome context did not retain its cookie")

        navigation = call("/scrape", {
            "url": url,
            "actions": [{"type": "click", "selector": "a[href='/next']"}],
        })
        require(navigation.get("url", "").endswith("/next"), "navigation URL incorrect")
        require("Navigation succeeded" in navigation.get("text", ""), "navigation failed")

        cleared = call("/context/clear", {"domain": "127.0.0.1"})
        require(cleared.get("success"), "context clear failed")
        after_clear = call("/scrape", {"url": url})
        require("Returning session" not in after_clear.get("text", ""),
                "context clear left persistent cookies behind")
        print("PASS: real Chrome navigation, DOM extraction, click/type, persistence and clear")
    except Exception:
        if cid:
            logs = subprocess.run(["docker", "logs", cid], capture_output=True, text=True)
            print("Chrome container logs:\n", logs.stdout[-5000:], logs.stderr[-5000:])
        raise
    finally:
        if cid:
            subprocess.run(["docker", "rm", "-f", cid], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=False)
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


if __name__ == "__main__":
    run()
