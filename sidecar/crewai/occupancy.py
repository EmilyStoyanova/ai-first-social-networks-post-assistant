"""Single-flight admission, with a busy state that tells the truth.

    python -m unittest test_occupancy -v

── Why this is not just a Semaphore ────────────────────────────────────────

It was one, and that hid a real defect. The sequence observed on the Mac:

  1. A live run started. `CREW_SIDECAR_TIMEOUT_MS` was 45 minutes, but the Node
     client dialled with `fetch`, whose undici transport abandons a request
     after its own 300s `headersTimeout`. The client gave up at five minutes.
  2. **The generation kept running.** The handler thread is inside a synchronous
     CrewAI `kickoff`; it cannot see that its client is gone, so Ollama carried
     on and the slot stayed held.
  3. The verifier then fired two concurrent probes. Both were refused
     `crew_busy` — correctly, because the abandoned run still owned the slot.
  4. The verifier read "one of the two was refused" as proof of serialization
     and PASSED.

A bare semaphore cannot tell those apart, because it records only a count. This
records WHO holds the slot, since WHEN, and whether that holder's client is
still connected — which is exactly the information that separates "serialization
works" from "an abandoned run is still occupying the service".

── On cancellation ─────────────────────────────────────────────────────────

There is none, and nothing here pretends otherwise. A CrewAI `kickoff` exposes
no cancellation token, and killing the thread running it is not safe in Python:
the thread owns litellm's HTTP connection to Ollama and CrewAI's own state, and
Python offers no way to interrupt a blocking C-level read. Ollama would keep
generating regardless — it is a separate process with a separate request.

So `mark_disconnected()` records a fact and changes no behaviour. It is
observability, not cancellation: it lets `/health` say "busy, and the occupant
was abandoned 4 minutes ago" instead of merely "busy", and it lets an operator
tell a wedged run from a legitimately long one without attaching a debugger.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Occupant:
    """The one generation currently allowed to run."""

    started_at: float
    #: Set when the occupant's HTTP client has provably gone away. Recorded
    #: only; it never interrupts the run. See the module docstring.
    client_disconnected: bool = False
    disconnected_at: float | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def mark_disconnected(self, at: float) -> None:
        with self._lock:
            if not self.client_disconnected:
                self.client_disconnected = True
                self.disconnected_at = at


class SingleFlight:
    """One generation at a time. Non-blocking: an overflow is refused, not queued.

    Refusing rather than queueing is the same decision the HTTP layer documents:
    a queue would hide latency inside a request the caller is already timing,
    and the worker's own job dedupe is the right place for the waiting.
    """

    def __init__(self, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._lock = threading.Lock()
        self._occupant: Occupant | None = None

    def try_acquire(self) -> Occupant | None:
        """The occupant token on success, None when the slot is already held."""
        with self._lock:
            if self._occupant is not None:
                return None
            self._occupant = Occupant(started_at=self._now())
            return self._occupant

    def release(self, occupant: Occupant) -> None:
        """Frees the slot — but only if `occupant` is the one that holds it.

        The identity check matters: a handler whose client vanished still runs
        to completion and still releases. If it released unconditionally, a late
        release from an abandoned run could free a slot that a NEWER generation
        had meanwhile acquired, and two runs would hit Ollama at once — the exact
        thing single-flight exists to prevent.
        """
        with self._lock:
            if self._occupant is occupant:
                self._occupant = None

    @property
    def occupant(self) -> Occupant | None:
        with self._lock:
            return self._occupant

    def snapshot(self) -> dict:
        """The busy state, shaped for `GET /health`.

        `runningForMs` is None when idle rather than 0, so "no occupant" and "an
        occupant that started this instant" stay distinguishable.
        """
        with self._lock:
            occupant = self._occupant
            if occupant is None:
                return {"busy": False, "runningForMs": None, "clientDisconnected": False}
            running_for = max(0, int((self._now() - occupant.started_at) * 1000))
            return {
                "busy": True,
                "runningForMs": running_for,
                "clientDisconnected": occupant.client_disconnected,
            }

    def busy_message(self) -> str:
        """The `503` body's message. Starts with `crew_busy` and then explains.

        The explanation is the point. `crew_busy` alone sent an operator looking
        for a concurrent caller that did not exist; naming the occupant's age and
        whether its client is gone points straight at the abandoned run instead.
        """
        state = self.snapshot()
        if not state["busy"]:
            # Raced: the occupant released between the refusal and this call.
            return "crew_busy"
        detail = f"crew_busy (a generation has been running for {state['runningForMs']}ms"
        if state["clientDisconnected"]:
            detail += ", and its client has disconnected — an abandoned run that "
            detail += "cannot be cancelled and must finish"
        return detail + ")"
