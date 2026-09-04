"""The HTTP surface: `POST /crew/post` and `GET /health`.

Stdlib `http.server` rather than FastAPI/uvicorn, deliberately. This service has
two endpoints, one caller, and a security posture built on having as little
installed as possible — every extra dependency is another package that runs at
import with the process's own privileges, and another row in the licence
inventory. A framework would buy routing and validation that two endpoints do
not need.

── Binding ─────────────────────────────────────────────────────────────────

`127.0.0.1` only, and a bind collision is FATAL. It never falls back to another
port: a sidecar quietly listening somewhere the worker is not configured to call
is a service that appears healthy and is never used.

── Serialization ───────────────────────────────────────────────────────────

One active generation at a time, enforced by a non-blocking semaphore, with
`503 crew_busy` on overflow. A clean, retryable refusal rather than a queue,
because a queue would hide latency inside a request the worker is already timing
— and the worker's own job dedupe is the right place for the waiting.

Note what this does NOT solve: the Vercel app calls the Mac text worker inline
(prompt-preview aspect mining, single-agent generation), and those can overlap a
CrewAI run on the same local Qwen. No amount of serialization HERE addresses
that. It is a measured, accepted cost.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from guards import main_guard

# The startup self-check runs BEFORE crew_flow is imported and before anything
# binds — importing CrewAI is itself a network-touching act (litellm fetches its
# cost map at import), so the suppression variables must already be set.
main_guard()

from crew_flow import run_flow  # noqa: E402 - must follow main_guard()

HOST = "127.0.0.1"
DEFAULT_PORT = 49510
MAX_BODY_BYTES = 2 * 1024 * 1024

_slot = threading.Semaphore(1)


def _model_identity(inference: dict) -> dict:
    """The tag as pinned, and the digest when Ollama exposes one.

    The digest is read from Ollama rather than assumed, and a null is reported
    honestly: a comparison over a null digest is labelled "tag-matched only" by
    the caller, never promoted to "digest-verified".
    """
    tag = str(inference.get("model", "")).replace("ollama/", "", 1)
    digest = None
    try:
        import urllib.request

        base = inference.get("baseUrl", "http://127.0.0.1:11434")
        req = urllib.request.Request(
            f"{base}/api/show",
            data=json.dumps({"model": tag}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as res:  # noqa: S310 - loopback only
            payload = json.loads(res.read())
        for key in ("digest", "sha256"):
            if isinstance(payload.get(key), str):
                digest = payload[key]
                break
        details = payload.get("details")
        if digest is None and isinstance(details, dict) and isinstance(details.get("digest"), str):
            digest = details["digest"]
    except Exception as err:  # noqa: BLE001 - an absent digest is a fact, not a failure
        print(f"[crew-sidecar] could not read the model digest: {err}")
    return {"tag": tag, "digest": digest}


class Handler(BaseHTTPRequestHandler):
    server_version = "crew-sidecar/1"

    def log_message(self, fmt: str, *args) -> None:
        # Never log a path with a query string or a body. The default handler's
        # request line is fine; the content is not ours to write down.
        print(f"[crew-sidecar] {fmt % args}")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"status": "error", "code": code, "message": message})

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's contract
        if self.path == "/health":
            self._json(200, {"status": "ok"})
            return
        self._error(404, "invalid_response", "Unknown path.")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/crew/post":
            self._error(404, "invalid_response", "Unknown path.")
            return

        expected = os.environ["CREW_SIDECAR_API_KEY"]
        if self.headers.get("x-worker-api-key") != expected:
            # No detail about WHY. An unauthenticated caller learns only that it
            # is unauthenticated.
            self._error(401, "unavailable", "Unauthorized.")
            return

        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self._error(400, "invalid_response", "Malformed content-length.")
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._error(413, "invalid_response", "Body missing or too large.")
            return

        try:
            request = json.loads(self.rfile.read(length))
        except (ValueError, TypeError):
            self._error(400, "invalid_response", "Body was not JSON.")
            return
        if not isinstance(request, dict) or "generationRequirements" not in request:
            self._error(400, "invalid_response", "Body did not match the /crew/post contract.")
            return

        # Non-blocking: an overflow is refused immediately rather than parked.
        if not _slot.acquire(blocking=False):
            self._error(503, "unavailable", "crew_busy")
            return
        try:
            self._generate(request)
        finally:
            _slot.release()

    def _generate(self, request: dict) -> None:
        try:
            result = run_flow(request)
        except Exception as err:  # noqa: BLE001
            # No usable Writer candidate. `unavailable` rather than a 500 body
            # with no code, so the caller classifies it as infrastructure and
            # its queue retries the job — without ever changing strategy.
            print(f"[crew-sidecar] run failed: {type(err).__name__}: {err}")
            self._error(503, "unavailable", f"{type(err).__name__}")
            return

        if not result.candidate or not result.candidate.strip():
            self._error(503, "unavailable", "The run produced no candidate.")
            return

        counters = result.counters
        self._json(
            200,
            {
                "status": "ok",
                "candidate": {"raw": result.candidate},
                "qa": {
                    "finalDecision": result.qa.decision,
                    "revisions": counters.revisions,
                    "issues": result.qa.issues,
                    "routes": counters.routes,
                },
                "agentCalls": {
                    "writer": counters.writer,
                    "editor": counters.editor,
                    "qa": counters.qa,
                },
                "latencyMs": result.latency_ms,
                "model": _model_identity(request["inferenceConfig"]),
                "degradedStages": counters.degraded_stages,
            },
        )


def main() -> None:
    port = int(os.environ.get("CREW_SIDECAR_PORT", DEFAULT_PORT))
    try:
        server = ThreadingHTTPServer((HOST, port), Handler)
    except OSError as err:
        # Fatal and loud. Choosing another port would leave a sidecar listening
        # where the worker will never call it.
        print(f"[crew-sidecar] cannot bind {HOST}:{port}: {err}", file=sys.stderr)
        raise SystemExit(1) from err

    print(f"[crew-sidecar] listening on {HOST}:{port} (loopback only, one generation at a time)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
