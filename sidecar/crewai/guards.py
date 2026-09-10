"""Startup self-check.

The guarantees this sidecar makes are enforced by the PROCESS, not by a review
that happened once. Every check below runs before the socket is bound, and a
failure exits non-zero WITHOUT binding — so a misconfigured sidecar is a service
that never came up, never a service that came up slightly wrong.

That ordering is the whole point. A sidecar that bound first and validated after
would spend the window between the two accepting real generation requests.
"""

from __future__ import annotations

import os
import sys

# ── Names that must never be in this process's environment ──────────────────
#
# `tools=[]` bounds what the AGENTS can invoke. It does NOT sandbox the Python
# process: CrewAI, litellm and every transitive dependency remain ordinary
# Python with whatever access the running user has. So the defence against a
# dependency reading a secret is that the secret is not here to read.
#
# Checked by NAME rather than by value because the failure being prevented is an
# operator copying the worker's `.env` across "so it has what it needs".
FORBIDDEN_ENV = (
    "DATABASE_URL",
    "DIRECT_URL",
    "LLM_ENCRYPTION_KEY",
    "NEXTAUTH_SECRET",
    "AUTH_SECRET",
    "CRON_SECRET",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "BUFFER_CLIENT_ID",
    "BUFFER_CLIENT_SECRET",
    "CLOUDINARY_URL",
    "CLOUDINARY_API_SECRET",
    "TEXT_WORKER_API_KEY",
    "WORKER_WAKE_SECRET",
)

# ── Telemetry and network-egress suppression ────────────────────────────────
#
# Every one of these closes a documented outbound destination. They are SET
# here, in-process, rather than left to a plist or a shell profile, because a
# launchd environment that silently loses one variable would otherwise be a
# silent network egress rather than a startup failure.
#
# `CREWAI_DISABLE_TELEMETRY` and `OTEL_SDK_DISABLED` are both required:
# crewAI#2945 reports the single flag having failed to suppress the OTEL
# exporter on its own.
REQUIRED_ENV = {
    # CrewAI → telemetry.crewai.com:4319, on every crew run.
    "CREWAI_DISABLE_TELEMETRY": "true",
    "OTEL_SDK_DISABLED": "true",
    # litellm → raw.githubusercontent.com for its model cost map, at import.
    "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    # chromadb → PostHog, at import.
    "ANONYMIZED_TELEMETRY": "false",
    # HF tokenizers → huggingface.co, on tokenizer resolution.
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    # No bytecode written beside a read-only install.
    "PYTHONDONTWRITEBYTECODE": "1",
}


class StartupCheckFailed(RuntimeError):
    pass


def apply_required_env() -> None:
    """Sets the suppression variables, overriding whatever was inherited.

    Deliberately an override rather than a default: a `.env` that switched
    telemetry back on must not win over the process's own posture.
    """
    for name, value in REQUIRED_ENV.items():
        os.environ[name] = value


def check_forbidden_env() -> None:
    present = [name for name in FORBIDDEN_ENV if os.environ.get(name)]
    if present:
        raise StartupCheckFailed(
            "Refusing to start: this process must hold no application secrets, "
            f"but these are set: {', '.join(sorted(present))}. "
            "The sidecar needs only CREW_SIDECAR_API_KEY and the Ollama base URL."
        )


def check_required_config() -> None:
    if not os.environ.get("CREW_SIDECAR_API_KEY"):
        raise StartupCheckFailed(
            "Refusing to start: CREW_SIDECAR_API_KEY is required so the sidecar can "
            "authenticate the worker."
        )


def assert_agent_posture(agents, crew=None) -> None:
    """Asserts the posture on the real objects, at startup, on every boot.

    Reading the constructor arguments in the source proves what was written;
    reading the attributes off a constructed object proves what the installed
    CrewAI version actually did with them — which is the thing that can change
    under a dependency bump without a line of this repo being touched.
    """
    for agent in agents:
        role = getattr(agent, "role", "<unnamed>")
        tools = getattr(agent, "tools", None)
        if tools:
            raise StartupCheckFailed(f"Agent {role!r} has tools: {tools!r}. Tools are forbidden.")
        for attr in ("allow_code_execution", "allow_delegation"):
            if getattr(agent, attr, False):
                raise StartupCheckFailed(f"Agent {role!r} has {attr} enabled.")
        # Memory would persist article and post text between runs, in a process
        # that is supposed to hold nothing between requests.
        if getattr(agent, "memory", False):
            raise StartupCheckFailed(f"Agent {role!r} has memory enabled.")

    if crew is not None:
        for attr in ("memory", "share_crew", "cache"):
            if getattr(crew, attr, False):
                raise StartupCheckFailed(f"Crew has {attr} enabled.")


def run_startup_checks() -> None:
    apply_required_env()
    check_forbidden_env()
    check_required_config()


def main_guard() -> None:
    """Runs the checks and exits non-zero on failure, before anything binds."""
    try:
        run_startup_checks()
    except StartupCheckFailed as err:
        print(f"[crew-sidecar] STARTUP CHECK FAILED: {err}", file=sys.stderr)
        raise SystemExit(2) from err
