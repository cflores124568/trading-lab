# C++ Kernel Notes

This is the fast path for the hot backtest loop, not the whole backtest system.

The actual numeric loop lives in `backend/cpp/backtest_core.cpp`. Python still
handles DataFrames, timestamps, strategy prep, metrics, and all the business-y
stuff around it in `backend/services/backtest_engine.py`.

## What It Does

The C++ module takes plain `close` and `signal` arrays, walks bar by bar,
manages one open position, applies commission, and returns flat numpy arrays
for equity and completed trades.

That keeps the part that needs speed in C++, while the rest of the app stays
easy to change in Python.

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

Right now the kernel is intentionally narrow. It does not know about DataFrame
indexes, prop-firm rules, or fancy order types. It just runs the position loop
fast and hands the results back to Python.

That trade-off is on purpose. It keeps the C++ piece small enough that I don't
hate touching it later.
