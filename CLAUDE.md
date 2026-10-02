# Claude Working Notes

Trading Lab is split across a SolidJS frontend, a FastAPI/Python backend, and a
small C++ backtest kernel. Keep those boundaries in mind and only reach across
them when the change really needs it.

Prefer small, targeted edits over broad refactors. If a change touches replay,
backtests, prop-firm evaluation, persistence, or data loading, make sure the
backend and frontend still agree on the shape and meaning of the data.

Useful docs:
- [`docs/CPP_KERNEL.md`](./docs/CPP_KERNEL.md)
- [`docs/PROP_FIRM_RULES.md`](./docs/PROP_FIRM_RULES.md)
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)
- [`frontend/README.md`](./frontend/README.md)

Don’t waste time editing generated stuff unless you really mean to:
`frontend/dist`, `frontend/node_modules`, `backend/venv`, `backend/cpp/build`,
`__pycache__`, `.pytest_cache`, and `.DS_Store`.

Safety first:
- never delete, overwrite, or “clean up” `backend/data/` unless the user
  explicitly asks for it
- treat `backend/db/`, `backend/.env`, and any local database contents as
  important state, not scratch space
- do not run destructive commands like `rm -rf`, `git reset --hard`,
  `git checkout --`, or bulk renames unless the user explicitly asks
- if a task might remove data, stop and confirm before touching anything
- when in doubt, prefer additive changes, backups, or temporary files in
  `/private/tmp` over in-place deletion

Good default checks:
- `npm run bootstrap` from the repo root when local infra needs to exist
- focused backend tests from `backend/` with `./venv/bin/python -m pytest`
- `npm run build` in `frontend/` for UI changes
- `npm run test:replay` in `frontend/` when replay logic changes

When an API, schema, or data contract changes, update the caller and callee in
the same pass so the app doesn’t drift into half-working state.
