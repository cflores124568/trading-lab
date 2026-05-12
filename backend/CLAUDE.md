# Backend Claude Notes

This is the FastAPI and Python side of Trading Lab. Keep route files thin,
prefer moving behavior into `services/`, and keep persistence changes lined up
with the matching repo/store helpers.

Use the local backend environment, not a global Python install. The usual entry
point is `./venv/bin/python`, and the backend docs assume you run commands from
`backend/`.

Main things to watch:
- `routers/` should mostly glue requests to services
- `services/` is where the actual business logic lives
- `db/schema.sql` and the `*_repo.py` / `*_store.py` files need to stay in sync
- `fetch_databento.py` can spend real money, so do not run it casually
- `backend/cpp/backtest_core.cpp` is only the hot loop, not the whole system

Safety rules:
- treat `backend/data/` as real source data, not a temp directory
- never delete or overwrite parquet, DB, or replay/session data unless the user
  explicitly asked for that exact cleanup
- do not drop tables, wipe volumes, or reset the local database just to make a
  test pass unless the user approved it first
- if cleanup is necessary, prefer making a copy, moving files aside, or using a
  new temp path under `/private/tmp`
- before any destructive change, double-check that the target is generated or
  disposable and not part of the project’s source of truth

If you touch the C++ kernel, remember the Python fallback still needs to work
and the compiled module has to land where `backend/services/backtest_engine.py`
expects it.

When backtest, replay, or prop-firm behavior changes, update the relevant
tests in `backend/test_*.py` and keep the docs honest. `docs/CPP_KERNEL.md` and
`docs/PROP_FIRM_RULES.md` are the right references for those areas.

Good checks:
- `./venv/bin/python -m pytest test_backtest.py`
- `./venv/bin/python -m pytest test_prop_firm_eval.py`
- the narrowest related `test_*.py` file for the thing you changed

Try to avoid broad cleanup in generated or local-state directories. If you find
stale `__pycache__`, `.pytest_cache`, or `backend/cpp/build` output, leave it
alone unless the task is specifically about build artifacts.
