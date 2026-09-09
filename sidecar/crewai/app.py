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

One active generation at a time, admitted by `occupancy.SingleFlight`, with
`503 crew_busy` on overflow. A clean, retryable refusal rather than a queue,
because a queue would hide latency inside a request the worker is already timing
— and the worker's own job dedupe is the right place for the waiting.

The slot carries WHO holds it and since when, not just a count, and `/health`
reports that. The reason is a real defect: a client that stops waiting does not
stop the generation, so the slot legitimately stays held afterwards and later
calls are refused — and with only a count to look at, "an abandoned run is still
occupying the service" is indistinguishable from "serialization works". See
`occupancy.py`, which also explains why there is no cancellation to offer.

Note what this does NOT solve: the Vercel app calls the Mac text worker inline
(prompt-preview aspect mining, single-agent generation), and those can overlap a
CrewAI run on the same local Qwen. No amount of serialization HERE addresses
that. It is a measured, accepted cost.

── Disconnect detection ────────────────────────────────────────────────────

While a generation runs, a daemon thread peeks at the client socket. A peer that
has closed becomes readable at EOF, which is how a disconnect is noticed without
consuming a byte (`MSG_PEEK`) and without touching the running Flow. It records
the fact and nothing more — the run is not interrupted, because it cannot be.
"""

from __future__ import annotations

import json
import os
import select
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from guards import main_guard
from occupancy import Occupant, SingleFlight

# The startup self-check runs BEFORE crew_flow is imported and before anything
# binds — importing CrewAI is itself a network-touching act (litellm fetches its
# cost map at import), so the suppression variables must already be set.
main_guard()

from crew_flow import StageFailure, run_flow  # noqa: E402 - must follow main_guard()

HOST = "127.0.0.1"
DEFAULT_PORT = 49510
MAX_BODY_BYTES = 2 * 1024 * 1024

_slot = SingleFlight()

#: How often the watcher checks whether the caller is still there. Long enough
#: to be free, short enough that `/health` is useful while a run is in flight.
_DISCONNECT_POLL_SECONDS = 2.0


def _watch_for_disconnect(
    connection: socket.socket, occupant: Occupant, done: threading.Event
) -> None:
    """Records the moment the caller goes away. Never interrupts the run.

    A peer that has closed its end makes the socket readable at EOF, so a
    zero-timeout `select` followed by a `MSG_PEEK` recv answers "is the client
    still there?" without consuming anything the handler might need. The client
    sends `connection: close` and this server speaks HTTP/1.0, so there is no
    pipelined next request that could be mistaken for a disconnect.

    Every failure here is swallowed: a watcher that cannot watch must degrade to
    knowing nothing, never take down a generation that is proceeding fine.
    """
    while not done.wait(_DISCONNECT_POLL_SECONDS):
        try:
            readable, _, _ = select.select([connection], [], [], 0)
            if not readable:
                continue
            if connection.recv(1, socket.MSG_PEEK) == b"":
                occupant.mark_disconnected(time.monotonic())
                print(
                    "[crew-sidecar] the caller disconnected; the generation CANNOT be cancelled "
                    "and continues to completion, holding the slot"
                )
                return
        except OSError:
            # A socket already torn down is itself a disconnect.
            occupant.mark_disconnected(time.monotonic())
            return
        except Exception as err:  # noqa: BLE001 - observability must never be fatal
            print(f"[crew-sidecar] disconnect watcher stopped: {type(err).__name__}: {err}")
            return


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
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller stopped waiting while the generation ran. Logged as the
            # ordinary outcome it is rather than raised as a traceback: the work
            # completed, and only its result was discarded. Nothing is retried
            # here — the caller's queue owns that decision.
            print(f"[crew-sidecar] the caller was gone when the {status} response was written")

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"status": "error", "code": code, "message": message})

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's contract
        if self.path == "/health":
            # Reachability AND the truthful busy state. `busy` is reported rather
            # than implied, so a caller never has to infer occupancy from a
            # refusal it cannot attribute.
            self._json(200, {"status": "ok", **_slot.snapshot()})
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
        # The message names the occupant's age and whether its client is gone,
        # because "busy" alone cannot distinguish a real concurrent caller from
        # an abandoned run that nobody is waiting for any more.
        occupant = _slot.try_acquire()
        if occupant is None:
            self._error(503, "unavailable", _slot.busy_message())
            return

        # Watch for the caller giving up. This RECORDS the disconnect; it does
        # not cancel anything, because a synchronous CrewAI kickoff cannot be
        # cancelled safely and Ollama would keep generating regardless.
        done = threading.Event()
        watcher = threading.Thread(
            target=_watch_for_disconnect,
            args=(self.connection, occupant, done),
            name="crew-disconnect-watch",
            daemon=True,
        )
        watcher.start()
        try:
            self._generate(request)
        finally:
            done.set()
            _slot.release(occupant)

    def _generate(self, request: dict) -> None:
        try:
            result = run_flow(request)
        except StageFailure as err:
            # A named stage produced nothing usable. Still `unavailable` — the
            # caller must classify it as infrastructure, retry the job and never
            # change strategy — but the STAGE travels with it, because "the run
            # failed" and "the Writer came back empty" lead to different
            # investigations and only the sidecar knows which happened.
            print(f"[crew-sidecar] run failed in stage {err.stage}: {err.detail}")
            self._error(503, "unavailable", f"{err.stage}: {err.detail}")
            return
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
                # `raw` is provenance/debug only. `json` is authoritative: a
                # strict Pydantic model, serialised by Pydantic, so the envelope
                # `json.dumps` below is valid whatever quote characters the post
                # text contains. `exclude_none` keeps the shape identical to what
                # a minimal post JSON produced before — absent optionals stay
                # absent rather than becoming explicit nulls.
                "candidate": {
                    "raw": result.candidate,
                    "json": result.parsed.model_dump(exclude_none=True),
                },
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
