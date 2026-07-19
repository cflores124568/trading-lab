# Paper Trading Operator Guide

This is the practical guide for Trading Lab's paper workflow. The `PHASE_3*.md`
files record engineering decisions; this document explains what to run, what to
click, and what state to expect.

Trading Lab remains paper-only. It does not connect to a broker, place real
orders, or consume Databento MBP-1 yet.

## Quick start

Run each process in a separate terminal.

```bash
# Terminal 1: create backend/.env if needed and start TimescaleDB
cd /Users/christopherflores/trading-lab
npm run bootstrap
```

```bash
# Terminal 2: start FastAPI
cd /Users/christopherflores/trading-lab/backend
./venv/bin/uvicorn main:app --reload
```

```bash
# Terminal 3: start the durable paper worker
cd /Users/christopherflores/trading-lab/backend
./venv/bin/python paper_runner_worker.py
```

```bash
# Terminal 4: start SolidJS
cd /Users/christopherflores/trading-lab/frontend
npm run dev
```

Open `http://localhost:3000`. The Vite server proxies `/api` requests to FastAPI
at `http://127.0.0.1:8000`.

If `trading_lab_paper_runner` is already running in Docker, do not also start a
local worker. Multiple workers are lease-safe, but the extra process makes local
operation harder to understand. Check with:

```bash
cd /Users/christopherflores/trading-lab/backend
docker compose ps
```

## The workflow

The current paper workflow is intentionally candidate-driven:

```text
Experiment -> Experiment run -> Promote -> Candidate
           -> Paper bot draft -> Paper session -> Historical paper runner
```

A normal saved backtest is analysis output. An experiment run can be promoted
because it carries the exact strategy configuration needed by the candidate and
paper runtime.

### 1. Produce a candidate

1. Open **Experiments**.
2. Create or open an experiment.
3. Run it over the intended symbol, interval, dates, parameters, and execution
   assumptions.
4. Review its completed runs.
5. Promote the run you want to evaluate.
6. Open **Candidates** and select the promoted candidate.

Promotion does not start paper execution. It only records that this exact run
is worth reviewing further.

### 2. Create the handoff and session

On the candidate detail page:

1. Find **Paper Handoff Stub**.
2. Click **Create Paper Bot Draft**.
3. Click **Mark Ready**.
4. Click **Create Paper Session**.

Mark the draft ready before creating the session. A session created from a
draft remains in `draft` and cannot start until it is moved to `ready` or
`paused`.

Trading Lab currently allows one durable paper session per candidate. If a
session already exists, the page shows **Open Paper Session** instead of
creating a second one.

### 3. Start safely in Shadow mode

On the paper-session detail page:

1. In **Paper Execution**, select **Shadow**.
2. Choose start and end dates that exist in the local candle database.
3. Leave the poll interval at `750 ms` unless you have a reason to change it.
4. Leave **Reset Cursor** off for a new session. Enable it only when deliberately
   rerunning an existing session from the beginning.
5. Click **Start Runner**.

The session should show `running`, runner health `healthy`, and policy mode
`shadow`. Bars, policy decisions, and scorecard counters will advance. Shadow
decisions never execute paper orders.

## Paper bot versus paper session

The names are similar, but they serve different purposes.

- **Paper bot draft:** the candidate-to-runtime configuration handoff. It carries
  symbol, interval, strategy parameters, and guardrails.
- **Paper session:** the durable runtime record. It owns the cursor, decisions,
  orders, fills, position, PnL, scorecard, events, and runner state.
- **Paper worker:** the background process that advances sessions whose durable
  status says they should run.

The candidate page's **Start Paper Bot** button changes handoff status. The
paper-session page's **Start Runner** button actually queues historical candle
processing.

## Policy modes

### Shadow

- Generates versioned policy decisions.
- Builds the shadow scorecard.
- Does not execute proposed orders.
- Best first mode for every new candidate.

### Approval Required

- Generates decisions normally.
- Pauses before a position-changing action.
- Requires **Approve & Execute** or **Reject** on the session page.
- Persists the pending decision across restarts.

### Autonomous Paper

- Sends eligible decisions through the pre-trade risk gate.
- Executes only approved simulated actions against the paper book.
- Pauses when risk blocks an action.
- Never places a real brokerage order.

## Session status and runner health

The **Paper Sessions** page is the operating index. It shows every durable
session, newest updates first.

Session status describes allowed runtime state:

| Status | Meaning |
| --- | --- |
| `draft` | Handoff is incomplete; runner cannot start. |
| `ready` | Session is configured and may start. |
| `running` | Durable intent says the worker should advance it. |
| `paused` | State is preserved and the worker must not advance it. |
| `stopped` | Explicitly stopped; move it to an allowed state before running. |
| `failed` | A runner or guardrail error requires inspection. |

Runner health summarizes what the historical runner last reported:

| Health | Meaning |
| --- | --- |
| `healthy` | Runner mode is active. |
| `paused` | Runner is intentionally paused. |
| `quiet` | Run completed and its parity check passed. |
| `drift` | Completed run has a parity mismatch. |
| `observed` | Historical work exists, but the runner is not active now. |
| `failed` | Runner reported an error. |
| `idle` | No bars have been processed. |

Refresh the list after changing a session if its card has not updated yet.

## What a paper session supports

Each session inherits its candidate's symbol, interval, strategy, parameters,
prop-firm rules, and execution assumptions. The session detail page supports:

- historical start/end windows, start, pause, and manual bar stepping;
- durable cursor reset;
- shadow, approval-required, and autonomous-paper policy modes;
- policy decision traces and shadow scorecards;
- pre-trade risk results and hard guardrails;
- an emergency paper kill switch;
- synthetic bid/ask execution and position marking;
- market, resting, replace, cancel, exit, and flatten simulations;
- positions, PnL, closed fills, active orders, and execution analytics;
- append-only session events and operator notes.

The source-neutral BBO/trade event layer is backend-only until the MBP-1 adapter
exists. There is no live-feed button in the frontend yet.

## Persistence and shutdown protocol

Paper state is stored in PostgreSQL's Docker `pgdata` volume. Quitting Docker,
restarting the computer, rebuilding a container, `docker compose stop`, and a
normal `docker compose down` preserve it.

Do not use `docker compose down -v`, delete the `pgdata` volume, or reset Docker
Desktop's data unless you intentionally want to erase the local database.

Before routine shutdown:

1. Open **Paper Sessions**.
2. Pause every session marked `running`.
3. Confirm each one shows `paused`.
4. Stop the worker/API or quit Docker.

If Docker stops while a session remains `running`, the worker can resume it
after restart because running intent and the cursor are durable. This is
expected recovery behavior.

## MCP and Codex

The `trading_lab` MCP server provides read-only candidate/session inspection and
one narrow audited note operation. Useful requests include:

- “List my paper sessions and identify anything running.”
- “Inspect this session's scorecard and latest policy decisions.”
- “Explain why this session is paused or failed.”
- “Add this operator note with idempotency key `review-2026-07-19-v1`.”

MCP cannot start a runner, resolve an approval, execute an order, or mutate the
kill switch. Those controls remain in the application/API safety boundary.

## Troubleshooting

### The frontend loads but data does not

Confirm FastAPI is running on port 8000 and TimescaleDB is healthy.

### Start Runner is disabled or rejected

Confirm that:

- the session is `ready` or `paused`;
- the kill switch is not engaged;
- no approval decision is pending;
- the date range is valid and has local candle data;
- PostgreSQL and the paper worker are running.

### The session says running but bars do not move

Check `docker compose ps`, the session's runner error, and the worker logs. A
running session needs one healthy worker able to acquire its lease.

### I want a completely new paper session

Promote a different experiment run to a new candidate. The current model is one
paper session per candidate rather than multiple disposable sessions attached
to the same candidate.

## Current boundary

Phase 3C froze paper policy, risk, approval, and execution semantics. Phase 3D
added MCP inspection and audited notes. Phase 3E moved runner ownership into a
durable leased worker. Phase 3F froze the provider-neutral BBO/trade intake
contract. The next market-data step is the Databento MBP-1 adapter and paper
soak testing; real brokerage execution remains out of scope.

The next research milestone is documented separately in
[`PHASE_4_ROADMAP.md`](../PHASE_4_ROADMAP.md). That roadmap splits Alpha Lab
into six deliberately bounded phases: research persistence, robust evaluation,
an unattended worker, the operator frontend, agentic hypothesis generation,
and forward paper qualification.

Alpha Lab Phases 4A and 4B are backend-only foundations. They persist
research campaigns and trials, validate walk-forward evidence, freeze research
finalists, and keep final holdout evidence sealed until a one-time evaluation.
They do not create candidates or paper sessions, and they do not change or
advance this guide's paper runtime. Phase 4C is the first phase that may add an
unattended research worker.

Phase 4C now provides that separate durable research worker. Run
`./venv/bin/python research_search_worker.py` locally, or use the
`research_worker` Docker Compose service. It searches development partitions
only and cannot create candidates, paper sessions, policy decisions, or paper
orders. The paper worker and research worker are separate processes with
separate lease tables.

Phase 4D adds the **Alpha Lab** operator screens at `/alpha-lab`. Draft creation
shows exact chronological partitions after the backend calculates them. Launch
review shows the deterministic grid size, trial cap, and wall-clock cap before
work is queued. Campaign detail keeps failed attempts visible and separates
validation ranking from sealed-holdout results.

A manual Alpha Lab promotion records a validated research candidate only after
all validation gates pass and the finalist is frozen. It does not create an
experiment candidate, paper bot, paper session, runner intent, policy decision,
or order.

Phase 4E adds a bounded backend contract for agent-proposed hypotheses. An
operator configures hypothesis and trial budgets first; unsupported, unsafe,
duplicate, near-duplicate, and over-budget attempts remain visible with
rejection reasons. Accepted proposals compile to the normal research trial
shape, but they do not run automatically. A human must explicitly invoke the
research execution route, after which the existing Alpha Lab validation and
finalist screens remain the review surface. The agent cannot change execution
assumptions or risk limits, promote a candidate, create or advance a paper
session, or place an order.

Phase 4F adds the explicit operator-controlled seam after that promotion. A
holdout-qualified finalist can be handed to one ordinary candidate, paper-bot
draft, and draft paper session from the Alpha Lab campaign screen. The handoff
does not start or advance the session. Complete the normal candidate review and
paper-bot readiness steps before running it.

Forward qualification starts in shadow mode. Autonomous-paper mode is blocked
while evidence is collecting, and approval-required mode stays blocked until
the configured minimum shadow observations and actionable decisions have been
recorded. Back in Alpha Lab, refresh the durable evidence snapshot to review
behavior drift, modeled execution cost, risk blocks, and all gates. Pause the
session before recording the one-way qualified or rejected outcome. A qualified
paper result is evidence under this protocol, not authorization for live
trading or a guarantee of profitability.
