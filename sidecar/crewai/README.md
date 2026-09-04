# CrewAI sidecar

The inner multi-agent loop — **Writer → Editor → QA** — as a local HTTP service.
It is a separate process, in a separate language, with a separate dependency
tree, and it holds no database, no Prisma, no application secrets and no tools.

```
Next.js / worker (TypeScript)          ← holds DATABASE_URL, runs the gates
        │  POST /crew/post             ← loopback, x-worker-api-key
        ▼
CrewAI sidecar (this directory)        ← no secrets, no tools, no memory
        │  http://127.0.0.1:11434
        ▼
Ollama → local Qwen                    ← the ONLY permitted destination
```

## ⚠ Status: not yet verified on the Mac

Written on a Windows dev machine where **neither CrewAI nor Ollama is
installed**, so nothing in `crew_flow.py` or `app.py` has executed. What _has_
been verified here is the pure routing logic (`qa_verdict.py`) and the whole
TypeScript side against a scripted sidecar double.

The CrewAI Flow API surface is version-sensitive. Before this is trusted, run
the four scenarios below on the Mac. `run_flow` is deliberately the only symbol
`app.py` imports from `crew_flow.py`, so a validated POC implementation can
replace that file's internals without touching the HTTP layer or the contract.

## Install

```bash
sudo -u _crewai python3 -m venv /usr/local/var/crewai-sidecar/venv
sudo -u _crewai /usr/local/var/crewai-sidecar/venv/bin/pip install -r requirements.txt
```

Installed under `/usr/local/var/crewai-sidecar/`, deliberately outside every
TCC-protected path (`~/Desktop`, `~/Documents`, `~/Downloads`) so no permission
prompt can ever appear. **A prompt appearing is itself a bug report.**

`tools=[]` bounds what the **agents** can invoke. It does not sandbox the Python
process — CrewAI, litellm and every transitive dependency remain ordinary Python
with the running user's access. Isolation comes from the OS: a dedicated
`_crewai` service account with no admin group and no login shell, a read-only
install, and a PF outbound filter keyed on that account.

## Run

```bash
CREW_SIDECAR_API_KEY=<shared with the worker> \
CREW_SIDECAR_PORT=49510 \
  /usr/local/var/crewai-sidecar/venv/bin/python app.py
```

Writable at runtime: `tmp/` and `log/` only. Everything else, `tiktoken/`
included, is read-only — see the env policy in the launchd plist.

## The two guarantees, and how they are enforced

**Startup refuses rather than degrades.** `guards.py` runs before the socket is
bound and before CrewAI is imported (importing litellm is itself a
network-touching act). It exits non-zero _without binding_ if any application
secret is present in the environment, or if `CREW_SIDECAR_API_KEY` is missing.
A bind collision is likewise fatal — it never picks another port, because a
sidecar listening where the worker will not call it looks healthy and is never
used.

**A QA reply that cannot be read is never a pass.** There is no default verdict
anywhere in `qa_verdict.py`; every path returns one of five explicit states. An
unreadable reply is `unavailable` (degraded — the caller's deterministic gates
become the whole verdict), and a rejection naming nothing actionable is
`rejected_unroutable` (a non-converged attempt, never acceptable even when every
gate passes).

## Sampling and thinking models — a defect that already bit

A live run failed with the sidecar logging:

```
ERROR: crewai.flow.runtime: Invalid response from LLM call - None or empty
POST /crew/post → 503
```

The cause was **`numPredict: 1024` in the fixture**. It maps to litellm's
`max_tokens` and then to Ollama's `num_predict`, a cap on tokens the model may
EMIT — and `qwen3.5:35b-a3b-q4_K_M` is a reasoning model whose `<think>`
preamble is charged against that same budget. It was cut off mid-reasoning and
emitted no answer, so CrewAI saw empty content. The isolated POC, which passed
`model` and `base_url` and nothing else, worked; the multi-agent prompts are
much longer, so the reasoning block is longer too.

The same wall was hit elsewhere in this repo:
`MAX_UNDERSTANDING_OUTPUT_TOKENS` went from 500 to 1200 because the old cap
"left a capable local model no room to finish a maximal answer, let alone one
that also emits a thinking preamble before its JSON".

**The fixture now pins no sampling at all**, which reproduces the POC exactly.
That is also the correct A/B default: the control arm's `TextWorkerProvider`
forwards `temperature`/`maxTokens` to Ollama **only when `format` is set**, and
post generation never sets it — so the control arm sends no sampling either. An
arm that pinned it here would differ on sampling while reporting the same model,
silently invalidating an experiment meant to vary orchestration alone.

The mapping stays in `inference_config.py` for a phase that deliberately pins
both arms. If you ever set `numPredict`, size it from a thinking model's real
output — never copy the single-agent request's 1024, which on that path is
never actually applied.

Every run now logs its LLM configuration, so this is a reading rather than a
guess:

```
[crew-sidecar] LLM kwargs: {'model': 'ollama/qwen3.5:35b-a3b-q4_K_M', 'base_url': 'http://127.0.0.1:11434'}
```

A stage that produces nothing names itself, so the 503 body says which:

```
[crew-sidecar] run failed in stage writer: RuntimeError: Invalid response from LLM call - None or empty
```

**An empty response remains a failure.** It is not retried, not substituted and
never becomes a PASS — the caller classifies it `unavailable`, releases its
claimed article and retries the job as multi-agent, with no strategy change and
no cloud fallback.

## Verification on the Mac

Two halves, and they are complementary rather than redundant. A real model
cannot be made to reject its own work on cue, so the ROUTING is proven
deterministically against the real `run_flow`, and the LIVE path is proven
separately against real Ollama. Neither half alone is sufficient.

### 1. Pure logic — stdlib only, no CrewAI, no Ollama

```bash
cd <repo>/sidecar/crewai && python3 -m unittest test_qa_verdict test_inference_config -v
```

`test_inference_config` guards a defect that already cost a live Mac run — see
**Sampling and thinking models** below.

### 2. The four Flow scenarios — real `run_flow`, no model call

```bash
cd <repo>/sidecar/crewai && python3 -m unittest test_flow_routing -v
```

`Process.sequential` cannot express a verdict that routes back to a _chosen_
earlier agent, so these prove the conditional routing works on the pinned
version. They drive the **actual production `run_flow`** — its real counters,
its real `parse_qa_reply`, its real Editor re-entry, its real degradation
handling — and stub exactly one thing: `_run_single`, the single seam where an
agent call leaves the process. That is the only part a script can replace,
because it is the only part a model owns.

| #                 | Path                                            | writer / editor / qa |
| ----------------- | ----------------------------------------------- | -------------------- |
| B-1 normal pass   | Writer → Editor → QA → PASS                     | 1 / 1 / 1            |
| B-2 editor-routed | Writer → Editor → QA → **Editor → QA**          | 1 / 2 / 2            |
| B-3 writer-routed | Writer → Editor → QA → **Writer → Editor → QA** | 2 / 2 / 2            |
| B-4 termination   | QA rejects every round; stops at `maxQaRounds`  | 3 / 3 / 3 at R=2     |

**B-3 is the one that matters most**: it proves the Editor is re-entered after a
Writer revision. The worst case is therefore `3 + 3R` calls, not `3 + 2R` — 9 at
R=2, not 7. The assertion is over the CALL ORDER, not only the counts, because
counters alone cannot tell `Writer → Editor → QA` from `Writer → QA → Editor`.
The TypeScript client independently re-derives the same arithmetic from the
counters this service reports and **refuses** a run whose Editor count is short,
so a regression surfaces at the caller too.

`test_4c`/`test_4d` are requirement 7: an unreadable QA reply and a QA that
raises both become `unavailable` — degraded, candidate kept, **never a pass**.

### 2b. Contract conformance — the production client, not a curl

```bash
cd <repo> && npm run crew:verify -- --live
```

Drives the **real `CrewSidecarClient`**: the real strict response schema, the
real `validateCallCounts`, the real `resolveQaState`, and the real
`parseLlmPost` on the candidate. A hand-checked `curl` proves only that a human
found the JSON reasonable; this proves the shipped parser accepts it.

Run without `--live` for configuration and reachability only (no model call).

### 3. Startup guard

```bash
DATABASE_URL=postgres://x CREW_SIDECAR_API_KEY=k python app.py; echo "exit=$?"
# expect exit=2, and NOTHING listening on the port
sudo lsof -nP -iTCP:49510 -sTCP:LISTEN   # expect no output
```

### 4. Serialization

Covered by `npm run crew:verify -- --live` (§2b), which fires two concurrent
requests and asserts one is refused. By hand:

```bash
# Two concurrent requests: the second must return 503 crew_busy immediately.
for i in 1 2; do curl -s -o /dev/null -w "%{http_code}\n" \
  -H "x-worker-api-key: $CREW_SIDECAR_API_KEY" \
  -H 'content-type: application/json' \
  --data @fixtures/request.json http://127.0.0.1:49510/crew/post & done; wait
```

### 5. Outbound audit — the authoritative control is a filter, not an observation

```
# /etc/pf.anchors/crewai
block drop out log quick on ! lo0 user _crewai
```

```bash
sudo pfctl -sr | grep -i skip          # confirm `set skip on lo0` is present
sudo pfctl -nf /etc/pf.anchors/crewai  # syntax check; confirm `user` is supported
sudo tcpdump -n -e -ttt -i pflog0      # the pass condition
sudo -u _crewai curl -m 5 https://example.com   # must be BLOCKED and LOGGED
```

**Pass condition: zero `pflog0` packets for `_crewai` across a 20-run set.**
Unrelated Mac traffic cannot appear there, which is why the filter is
authoritative and a `tcpdump` observation is only corroboration. `-i any` is a
Linux feature and is **not** supported by macOS tcpdump — use `pktap,all` with
`-k` if you want per-process attribution.

Run 20 generations, not one boot: several destinations fire lazily on first
tokenizer use rather than at import, so a boot-only capture comes back clean and
is wrong.

| Source           | Destination                                     | Neutralised by                                                                                  |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| CrewAI telemetry | `telemetry.crewai.com:4319`                     | `CREWAI_DISABLE_TELEMETRY` **and** `OTEL_SDK_DISABLED` (crewAI#2945: one flag alone has failed) |
| litellm          | `raw.githubusercontent.com` cost map, at import | `LITELLM_LOCAL_MODEL_COST_MAP=True`                                                             |
| tiktoken         | `openaipublic.blob.core.windows.net`            | pre-baked `TIKTOKEN_CACHE_DIR`                                                                  |
| chromadb         | PostHog                                         | `ANONYMIZED_TELEMETRY=false`; `memory=False`                                                    |
| HF tokenizers    | `huggingface.co`                                | `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`                                                    |
| Ollama           | `127.0.0.1:11434`                               | **the only permitted destination**                                                              |

`guards.py` sets every one of those in-process rather than trusting the plist,
so a launchd environment that loses a variable is a startup failure and not a
silent network egress.

### 6. Filesystem writes

```bash
sudo fs_usage -w -f filesys -p <pid>   # across the 20-run set, writes only
```

Every write outside `tmp/` and `log/` is investigated and either eliminated or
added to the policy **in writing**.

### 7. Latency and contention

Record p50/p95/max per stage and per whole call. **Measure the all-writer-routed
worst case directly — do not extrapolate it from editor-routed runs.** Then set
`CREW_SIDECAR_TIMEOUT_MS` from measured p95 plus headroom; the compile-time
default is a `(3+3R) × 300s` abort ceiling, not an expectation.

Serializing this service does **not** prevent contention. The Vercel app calls
the Mac text worker inline (prompt-preview aspect mining, single-agent
generation) and those can overlap a CrewAI run on the same local Qwen. Nothing
here addresses that; it is an accepted, documented cost. If measurement shows
the overlap distorts the experiment, the fallback is a shared lock in front of
Ollama.

## Out of scope

CrewAI tools of any kind; CrewAI memory, knowledge or delegation; per-agent
model selection; `app.crewai.com` / CrewAI Cloud; any cloud LLM fallback.
