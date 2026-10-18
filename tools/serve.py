#!/usr/bin/env python3
"""
serve.py — run Lodestone from your own computer, and lend that computer's
model to your phone.

    python3 tools/serve.py                      # app on :8765, model server = Ollama on :11434
    python3 tools/serve.py --model qwen3:8b     # also point Ollama's "lodestone" model at qwen3:8b
    python3 tools/serve.py --upstream http://127.0.0.1:1234/v1   # LM Studio
    python3 tools/serve.py --port 9000 --lan    # also reachable from phones on your network

It serves app/ and forwards /v1/* to the model server, so the page and the model share
one origin: no CORS setup, no mixed-content block. Open the printed address on your phone
(same Wi-Fi) and choose "My computer's model server"; the setup screen finds it by itself.

With Ollama it also corrects two things Ollama's OpenAI-compatible endpoint gets wrong
for Lodestone (both reproduced on Ollama 0.34.4, 28 Sep 2026):

  * Context. /v1 ignores num_ctx and runs at Ollama's default window — 4,096 tokens on
    any machine with under 24 GB of VRAM. The full doctrinal backbone is ~17,000 tokens,
    so it was cut before the model read it. Chat is sent to Ollama's native /api/chat
    with num_ctx 32768 instead.
  * Thinking. Reasoning models think by default on /v1 and can spend the whole token
    budget before answering, which arrives as an empty reply. think:false is sent to
    any model that reports the capability.

Everything else passes through untouched; a non-Ollama upstream passes through entirely.
The desktop app (desktop/src/server.js) does the same.

Nothing is logged, and nothing leaves your network. Standard library only.
"""
import argparse
import http.server
import json
import socket
import socketserver
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
NUM_CTX = 32768
ALIAS = "lodestone"


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ollama_root(upstream: str):
    """The Ollama base URL behind an OpenAI-compatible upstream, or None if it is not Ollama."""
    root = upstream.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    try:
        with urllib.request.urlopen(root + "/api/version", timeout=2) as r:
            return root if "version" in json.loads(r.read() or b"{}") else None
    except Exception:
        return None


def post_json(url, body, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def make_alias(root, model, ctx):
    """Point Ollama's "lodestone" model at `model` with Lodestone's window baked in."""
    post_json(root + "/api/create", {"model": ALIAS, "from": model, "parameters": {"num_ctx": ctx}, "stream": False})


def smoke_test(root, ctx):
    """Ask the lodestone model one plain question at the full window. Proves the weights load
    at that size and the chat template works (a broken one answers with punctuation)."""
    caps = post_json(root + "/api/show", {"model": ALIAS}, timeout=30).get("capabilities") or []
    body = {"model": ALIAS, "stream": False, "keep_alive": "30m",
            "messages": [{"role": "user", "content": "In one short sentence: what colour is a clear daytime sky?"}],
            "options": {"num_ctx": ctx, "num_predict": 60, "temperature": 0}}
    if "thinking" in caps:
        body["think"] = False
    j = post_json(root + "/api/chat", body, timeout=900)
    text = ((j.get("message") or {}).get("content") or "").strip()
    if j.get("error") or sum(ch.isalpha() for ch in text) < 8:
        raise RuntimeError(j.get("error") or f"it answered {text[:60]!r}")
    return text


def make_handler(upstream: str, root, ctx: int):
    upstream = upstream.rstrip("/")
    caps_cache = {}

    def capabilities(model):
        if model not in caps_cache:
            try:
                caps_cache[model] = post_json(root + "/api/show", {"model": model}, timeout=10).get("capabilities") or []
            except Exception:
                return []
        return caps_cache[model]

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(APP), **kw)

        def log_message(self, *a):  # no logs: practitioner traffic is not recorded
            pass

        def end_headers(self):
            p = self.path.split("?")[0]
            if p.endswith("sw.js") or p.endswith(".html") or p == "/":
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def guess_type(self, path):
            if str(path).endswith(".webmanifest"):
                return "application/manifest+json"
            if str(path).endswith(".mjs"):
                return "text/javascript"
            # .wasm must be typed here, not added in end_headers: sending a second
            # Content-Type makes the browser refuse to stream-compile it
            # ("Incorrect response MIME type") and fall back to ArrayBuffer.
            if str(path).endswith(".wasm"):
                return "application/wasm"
            if str(path).endswith(".onnx"):
                return "application/octet-stream"
            return super().guess_type(path)

        # ── helpers ──────────────────────────────────────────────────────────
        def _json(self, code, obj):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def _unreachable(self, e):
            self._json(502, {"error": f"model server unreachable at {upstream}: {e}"})

        # ── plain pass-through (everything that is not Ollama chat) ──────────
        def _proxy(self, method, body=None):
            target = upstream + self.path[len("/v1"):]
            req = urllib.request.Request(target, data=body, method=method,
                                         headers={"Content-Type": self.headers.get("Content-Type", "application/json")})
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    self.send_response(r.status)
                    self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")  # HTTP/1.0: body ends when the socket closes
                    self.end_headers()
                    while True:
                        chunk = r.read1(8192) if hasattr(r, "read1") else r.read(8192)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    self.close_connection = True
            except urllib.error.HTTPError as e:
                data = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (urllib.error.URLError, ConnectionError) as e:
                self._unreachable(e)

        # ── /v1/models with Lodestone's model first (the setup screen takes the first) ──
        def _models(self):
            try:
                with urllib.request.urlopen(upstream + "/models", timeout=10) as r:
                    j = json.loads(r.read() or b"{}")
            except Exception as e:
                return self._unreachable(e)
            data = j.get("data") or []
            ours = lambda m: m.get("id") in (ALIAS, ALIAS + ":latest")
            j["data"] = [m for m in data if ours(m)] + [m for m in data if not ours(m)]
            self._json(200, j)

        # ── /v1/chat/completions → Ollama /api/chat, answered as OpenAI SSE ──
        def _chat(self, raw):
            try:
                o = json.loads(raw or b"{}")
            except ValueError:
                return self._json(400, {"error": "invalid JSON"})
            stream = o.get("stream", True) is not False
            opts = {"num_ctx": ctx, "temperature": o.get("temperature"), "top_p": o.get("top_p"),
                    "presence_penalty": o.get("presence_penalty"), "frequency_penalty": o.get("frequency_penalty"),
                    "num_predict": o.get("max_tokens", o.get("max_completion_tokens")), "stop": o.get("stop"),
                    "seed": o.get("seed")}
            payload = {"model": o.get("model"), "messages": o.get("messages") or [], "stream": stream,
                       "keep_alive": "30m", "options": {k: v for k, v in opts.items() if v is not None}}
            if "thinking" in capabilities(o.get("model")):
                payload["think"] = False
            req = urllib.request.Request(root + "/api/chat", data=json.dumps(payload).encode(), method="POST",
                                         headers={"Content-Type": "application/json"})
            cid, created, model = f"chatcmpl-{int(time.time() * 1000):x}", int(time.time()), o.get("model")
            try:
                r = urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as e:
                return self._json(e.code, {"error": e.read().decode("utf-8", "replace")[:500]})
            except (urllib.error.URLError, ConnectionError) as e:
                return self._unreachable(e)
            with r:
                if not stream:
                    j = json.loads(r.read() or b"{}")
                    if j.get("error"):
                        return self._json(500, {"error": j["error"]})
                    pt, ct = j.get("prompt_eval_count", 0), j.get("eval_count", 0)
                    return self._json(200, {
                        "id": cid, "object": "chat.completion", "created": created, "model": model,
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": (j.get("message") or {}).get("content", "")},
                                     "finish_reason": "length" if j.get("done_reason") == "length" else "stop"}],
                        "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct}})
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()

                def emit(obj):
                    self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
                    self.wfile.flush()

                def chunk(delta, finish=None, **extra):
                    emit({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                          "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra})
                try:
                    for line in r:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            j = json.loads(line)
                        except ValueError:
                            continue
                        if j.get("error"):
                            emit({"error": {"message": j["error"]}})
                            break
                        d = (j.get("message") or {}).get("content")
                        if d:
                            chunk({"content": d})
                        if j.get("done"):
                            pt, ct = j.get("prompt_eval_count", 0), j.get("eval_count", 0)
                            chunk({}, "length" if j.get("done_reason") == "length" else "stop",
                                  usage={"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct})
                            break
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the practitioner pressed Stop; closing r ends the generation
                self.close_connection = True

        def do_GET(self):
            if self.path.split("?")[0] == "/v1/models" and root:
                return self._models()
            if self.path.startswith("/v1/"):
                return self._proxy("GET")
            return super().do_GET()

        def do_POST(self):
            if not self.path.startswith("/v1/"):
                return self.send_error(405)
            body = self._body()
            if root and self.path.split("?")[0] == "/v1/chat/completions":
                return self._chat(body)
            return self._proxy("POST", body)

    return H


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--upstream", default="http://127.0.0.1:11434/v1", help="OpenAI-compatible base URL")
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces so a phone on your Wi-Fi can connect")
    ap.add_argument("--model", help="Ollama only: point the 'lodestone' model at this one, with Lodestone's context window")
    ap.add_argument("--check", action="store_true", help="with --model: ask it one question before serving, and stop if it cannot answer")
    ap.add_argument("--ctx", type=int, default=NUM_CTX, help="Ollama only: context window in tokens (default 32768)")
    args = ap.parse_args()
    if not (APP / "corpus" / "corpus.json").exists():
        sys.exit("No corpus pack yet — run: python3 tools/build-corpus.py")
    root = ollama_root(args.upstream)
    if args.model:
        if not root:
            sys.exit(f"--model needs Ollama, and none answered at {args.upstream}")
        try:
            make_alias(root, args.model, args.ctx)
        except Exception as e:
            sys.exit(f"Ollama could not prepare {args.model}: {e}")
        if args.check:
            print(f"Loading {args.model} and asking it one question…", flush=True)
            try:
                smoke_test(root, args.ctx)
            except Exception as e:
                # Exit status 3 tells the launchers the model is the problem, not the folder.
                print(f"The model did not answer properly: {e}", file=sys.stderr)
                sys.exit(3)
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    with Server((host, args.port), make_handler(args.upstream, root, args.ctx)) as httpd:
        print(f"Lodestone  →  http://localhost:{args.port}/")
        if args.lan:
            print(f"From your phone (same Wi-Fi)  →  http://{lan_ip()}:{args.port}/")
            print("  On the phone choose \"My computer's model server\"; it is detected automatically.")
        if root:
            print(f"Model server   →  Ollama at {root}, {args.ctx:,}-token window" + (f", model {args.model}" if args.model else ""))
        else:
            print(f"Model server   →  {args.upstream} (set its context window to at least 24,000 tokens)")
        print("Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
