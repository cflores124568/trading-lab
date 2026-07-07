# C++ Kernel Notes

This is the fast path for the hot backtest loop, not the whole backtest system.

The actual numeric loop lives in `backend/cpp/backtest_core.cpp`. Python still
handles DataFrames, timestamps, strategy prep, metrics, and all the business-y
stuff around it in `backend/services/backtest_engine.py`.

## What It Does

The C++ module takes plain OHLC + `signal` arrays, walks bar by bar, manages
one open position, applies commission, and returns flat numpy arrays for
equity and completed trades.

It covers all three execution styles the app knows: legacy bar fills,
synthetic bid/ask quotes (same spread rules as paper/replay), and
stop/take-profit bracket exits. So the C++ path is the primary engine now,
not just the fast lane for the simple case.

The pure-Python loop in `backtest_engine._run_python` didn't go away — it's
the reference implementation. `test_backtest_parity.py` runs both engines on
the same random-walk data across every mode combo and demands identical
trades and equity, down to the float. If you touch the kernel and that test
fails, the kernel drifted; fix the C++, not the test.

On an M1 Air, 100k bars runs in ~36 ms in bar mode and ~57 ms with synthetic
quotes + brackets, versus ~3-3.8 s for the Python loop (roughly 65-85x).

## Batch Mode

`run_backtest_batch` runs a whole parameter grid in one call: one shared set
of OHLC arrays, N signal arrays, fanned out across a `std::thread` pool with
the GIL released. Threads read the same price memory instead of copying the
dataset per run, which is exactly what an 8GB machine wants. Experiments go
through this path via `backtest_engine.run_backtest_batch`, which also keeps
a pure-Python fallback loop so nothing breaks without the compiled module.

Numbers worth knowing (M1 Air, 64 runs x 100k bars, synthetic + brackets):
the raw kernel pool finishes in ~20 ms; the Python wrapper lands around
0.35 s because materializing trade dicts and equity lists for the app is
serial Python and now dominates. That's still ~1.7x over sequential C++
calls and hundreds of times faster than the old Python loop, but the honest
takeaway is that the bar loop stopped being the bottleneck — result
materialization and indicator prep are next in line.

## When To Build It

You do not need to build it just to work on the app.

The Python fallback is already wired in, so local dev, route work, UI work,
and most everyday commits are fine without compiling anything. I would only
bother building it when one of these is true:

- you changed `backend/cpp/backtest_core.cpp`
- you want to verify the pybind11 path still compiles cleanly
- backtests are starting to feel slow enough that the Python fallback is annoying
- you want the real C++ story ready for a demo or recruiter walkthrough

## Local Build

Run this from `backend/cpp`:

```bash
cd /Users/chrisflores/trading-lab/backend/cpp
python -m pip install pybind11
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
find build -name 'backtest_core*.so*' -exec cp {} .. \;
```

That last copy matters. `backtest_engine.py` imports `backtest_core` as a
top-level module, so the compiled extension needs to end up in `backend/`,
not buried inside `backend/cpp/` and not in `backend/services/`.

If the copy lands in the wrong place, the app just falls back to Python and it
can look like "nothing happened".

## Files That Matter

- `backend/cpp/backtest_core.cpp`: the hot loop and pybind11 module
- `backend/cpp/CMakeLists.txt`: local build config
- `backend/services/backtest_engine.py`: Python wrapper plus fallback path
- `backend/Dockerfile`: production/container build copies the compiled `.so` into `/app`

## Docker Behavior

The backend Docker image already tries to build the kernel during the image
build. If it succeeds, the `.so` gets copied into the app root. If not, the
container still runs and the Python fallback stays alive.

That is the same philosophy as local dev: nice speedup when available, no drama
when it isn't.

## Current Limits

The kernel still doesn't know about DataFrame indexes, prop-firm rules, or
resting orders. Python handles timestamps, metrics, and prop evaluation
around it. One dispatch edge: quote mode and brackets need `high`/`low`
columns, so a dataset without them quietly takes the Python path instead.

Rounding is deliberately Python-shaped: `nearbyint` (ties-to-even) instead of
`std::round`, because Python's `round()` is banker's rounding and the parity
test checks exact equality. Same reason the build stays away from
`-ffast-math` — it lets the compiler reorder float math and would break
bit-level parity with the oracle.

That trade-off is on purpose. It keeps the C++ piece small enough that I don't
hate touching it later.
