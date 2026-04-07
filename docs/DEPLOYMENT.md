# Deployment Notes

The clean deployment shape for Trading Lab is a split setup:

- static frontend on something like Vercel, Netlify, or Cloudflare Pages
- containerized FastAPI backend on something like Render, Fly.io, or Railway
- managed Postgres/TimescaleDB behind the backend

I would not try to turn this into a pure frontend app. Too much important stuff
needs a real server.

## Why The Backend Stays Real

The backend is doing more than serving JSON for fun:

- it protects private ingestion credentials like Databento keys
- it proxies `yfinance` requests so the browser isn't talking to third-party APIs directly
- it owns DB access and TimescaleDB queries
- it persists backtests and replay sessions
- it can build and run the C++ pybind11 kernel in the same environment

That makes the "hybrid" shape the sane one here, not a compromise.

## Recommended First Hosted Setup

For the first recruiter-friendly demo, I would keep it simple:

1. Deploy the frontend as a static site.
2. Deploy the backend from `backend/Dockerfile`.
3. Use a managed Postgres instance with Timescale support if available.
4. Point the backend at that DB with `DATABASE_URL`.
5. Add a frontend rewrite or proxy so `/api/*` reaches the backend.

That last one matters because the frontend currently calls relative `/api`
routes in `frontend/src/services/api.ts`.

## Frontend Hosting Notes

The frontend is a normal Vite + SolidJS app. Static hosting is the easy part.

The only thing you have to be careful with is API routing. Local dev already
proxies `/api` through Vite, but production needs the same idea implemented with
hosting rewrites or by serving the frontend and backend behind one shared domain.

## Backend Hosting Notes

`backend/Dockerfile` is already pointed in the right direction:

- it installs Python dependencies
- it tries to build the C++ kernel during the image build
- it copies any compiled `backtest_core*.so` into the app root
- it starts FastAPI with Uvicorn

That means a container platform is the path of least pain here.

## Database Notes

Trading Lab is not just a stateless API. The database matters for:

- historical OHLCV bars in `ohlcv_1m`
- saved backtests
- saved replay sessions
- symbol metadata

For local dev, Docker handles that. In hosted environments, use managed
Postgres/Timescale instead of trying to fake it with files or in-memory state.

## What I Would Avoid

- putting Databento access in the browser
- pretending parquet files are the production database
- shipping a frontend-only demo that breaks the moment replay persistence matters
- overcomplicating the first deployment with Kubernetes or a bunch of sidecars

## Good Demo Goal

The first hosted version does not need to be perfect. It just needs to prove the
stack is real:

- browse symbols from the DB
- run backtests
- save and compare them
- launch and resume standalone replay sessions

That is already more convincing than a fake dashboard with no persistence behind it.
