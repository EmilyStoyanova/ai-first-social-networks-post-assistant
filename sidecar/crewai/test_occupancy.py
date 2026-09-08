"""Tests for single-flight admission and the busy state it reports.

    python -m unittest test_occupancy -v

Standard library only — no CrewAI, no Ollama, no HTTP. The clock is injected, so
"an abandoned run that has been going for eleven minutes" is a value rather than
a wait.

These exist because of a real defect chain observed on the Mac: undici abandoned
a live request at its own 300s headers timeout, the generation kept running
(nothing can cancel it), the slot stayed held, both of the verifier's concurrent
probes were refused, and the verifier read that as serialization working. A
counting semaphore cannot tell those apart. See `occupancy.py`.
"""

from __future__ import annotations

import threading
import unittest

from occupancy import SingleFlight


class FakeClock:
    """A monotonic clock that only moves when a test says so."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class TestAdmission(unittest.TestCase):
    def test_the_first_caller_is_admitted(self) -> None:
        slot = SingleFlight()
        self.assertIsNotNone(slot.try_acquire())

    def test_the_second_caller_is_refused_rather_than_queued(self) -> None:
        slot = SingleFlight()
        slot.try_acquire()
        self.assertIsNone(slot.try_acquire())

    def test_releasing_readmits(self) -> None:
        slot = SingleFlight()
        occupant = slot.try_acquire()
        assert occupant is not None
        slot.release(occupant)
        self.assertIsNotNone(slot.try_acquire())

    def test_a_stale_release_cannot_free_someone_elses_slot(self) -> None:
        """The identity check, and why it is load-bearing.

        An abandoned run still finishes and still releases. If release were
        unconditional, that late release could free a slot a NEWER generation had
        meanwhile acquired — and two runs would hit the same local Ollama at
        once, which is the exact thing single-flight exists to prevent.
        """
        slot = SingleFlight()
        first = slot.try_acquire()
        assert first is not None
        slot.release(first)
        second = slot.try_acquire()
        assert second is not None

        slot.release(first)  # the late, stale release

        self.assertIsNone(slot.try_acquire(), "the second occupant must still hold the slot")

    def test_only_one_of_many_threads_is_admitted(self) -> None:
        slot = SingleFlight()
        admitted: list[object] = []
        lock = threading.Lock()
        start = threading.Barrier(8)

        def contend() -> None:
            start.wait()
            token = slot.try_acquire()
            if token is not None:
                with lock:
                    admitted.append(token)

        threads = [threading.Thread(target=contend) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(admitted), 1)


class TestSnapshot(unittest.TestCase):
    def test_idle_reports_not_busy_and_a_null_age(self) -> None:
        # None rather than 0: "nobody is running" and "somebody started this
        # instant" are different facts and must stay distinguishable.
        self.assertEqual(
            SingleFlight(now=FakeClock()).snapshot(),
            {"busy": False, "runningForMs": None, "clientDisconnected": False},
        )

    def test_busy_reports_how_long_the_occupant_has_been_running(self) -> None:
        clock = FakeClock()
        slot = SingleFlight(now=clock)
        slot.try_acquire()
        clock.advance(93.5)
        self.assertEqual(
            slot.snapshot(),
            {"busy": True, "runningForMs": 93500, "clientDisconnected": False},
        )

    def test_the_abandoned_run_is_visible_as_such(self) -> None:
        """THE regression guard for the observed defect.

        A client that stops waiting does not stop the generation. This is the
        state that must be readable afterwards, so that a later `crew_busy` can
        be attributed instead of being mistaken for working serialization.
        """
        clock = FakeClock()
        slot = SingleFlight(now=clock)
        occupant = slot.try_acquire()
        assert occupant is not None

        clock.advance(306.5)  # undici gave up here, on its own schedule
        occupant.mark_disconnected(clock())
        clock.advance(240.0)  # and the generation carried on for four more minutes

        state = slot.snapshot()
        self.assertTrue(state["busy"], "the run continues — it was never cancelled")
        self.assertTrue(state["clientDisconnected"])
        self.assertEqual(state["runningForMs"], 546500)

    def test_a_disconnect_is_recorded_once(self) -> None:
        clock = FakeClock()
        slot = SingleFlight(now=clock)
        occupant = slot.try_acquire()
        assert occupant is not None
        occupant.mark_disconnected(100.0)
        occupant.mark_disconnected(200.0)
        self.assertEqual(occupant.disconnected_at, 100.0)

    def test_the_disconnect_flag_does_not_survive_the_occupant(self) -> None:
        # A fresh generation must never inherit the previous one's abandonment.
        clock = FakeClock()
        slot = SingleFlight(now=clock)
        occupant = slot.try_acquire()
        assert occupant is not None
        occupant.mark_disconnected(clock())
        slot.release(occupant)
        slot.try_acquire()
        self.assertFalse(slot.snapshot()["clientDisconnected"])


class TestBusyMessage(unittest.TestCase):
    def test_it_always_starts_with_the_crew_busy_token(self) -> None:
        # The caller's verifier matches on this token, and `503` alone is not
        # proof of admission control — a 503 from any other cause would pass a
        # status-only check.
        clock = FakeClock()
        slot = SingleFlight(now=clock)
        slot.try_acquire()
        self.assertTrue(slot.busy_message().startswith("crew_busy"))

    def test_it_names_the_occupants_age(self) -> None:
        clock = FakeClock()
        slot = SingleFlight(now=clock)
        slot.try_acquire()
        clock.advance(12.0)
        self.assertIn("12000ms", slot.busy_message())

    def test_it_says_when_the_occupant_was_abandoned(self) -> None:
        clock = FakeClock()
        slot = SingleFlight(now=clock)
        occupant = slot.try_acquire()
        assert occupant is not None
        occupant.mark_disconnected(clock())
        message = slot.busy_message()
        self.assertIn("disconnected", message)
        self.assertIn("cannot be cancelled", message)

    def test_a_race_with_release_still_yields_a_usable_message(self) -> None:
        # Refused, then the occupant finished before the message was built.
        self.assertEqual(SingleFlight(now=FakeClock()).busy_message(), "crew_busy")


if __name__ == "__main__":
    unittest.main()
