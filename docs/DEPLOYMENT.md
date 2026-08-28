# Deployment Notes

## AWS EC2 Demo Deployment

The repository now has a root `compose.yaml` that runs the complete demo on one
host:

- Nginx serves the SolidJS production build on port 80
- Nginx proxies relative `/api/*` requests to FastAPI on the private Compose network
- FastAPI runs with one Uvicorn worker to fit a small burstable instance
- the paper and Alpha Lab workers run as separate processes
- TimescaleDB stores application and market data in the named `pgdata` volume

Only Nginx is published to the host. FastAPI and TimescaleDB must not be exposed
directly to the internet.

### EC2 shape

For the current AWS Free Plan deployment, use an Ubuntu 24.04 ARM64
`t4g.small` in `us-east-1`, configured in Standard CPU-credit mode. The complete
five-container stack used about 505 MiB at rest and peaked around 531 MiB during
a 50,000-bar backtest in local ARM64 testing, so 2 GiB of RAM plus a 2 GiB swap
file is enough for this single-user demo. Re-measure before adding concurrency
or additional workers.

Give the instance 30 GiB of encrypted gp3 storage. The pinned TimescaleDB image
is multi-architecture, so ARM is supported; the reason not to use RDS
PostgreSQL is that RDS does not offer the TimescaleDB extension required by
`backend/db/schema.sql`.

Security-group ingress:

- TCP 22 from the operator's current public IP only
- TCP 80 from `0.0.0.0/0` and `::/0`
- TCP 443 from `0.0.0.0/0` and `::/0` only after TLS is configured
- no public rules for 8000 or 5432

### First boot

SSH into the instance, then install Docker from Docker's official Ubuntu
repository. Add the login user to the `docker` group and start a fresh shell.
Create swap before building the images:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Clone and start the application:

```bash
git clone git@github.com:cflores124568/trading-lab.git
cd trading-lab
cp .env.deploy.example .env
nano .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl http://127.0.0.1/healthz
```

Generate `POSTGRES_PASSWORD` with a password manager or `openssl rand -hex
32`. Do not reuse the local `trading` password. The first database start runs
`backend/db/schema.sql`; later container restarts preserve the named volume.
Never run `docker compose down -v` against a deployment whose data matters.

After the instance works over HTTP, add a stable hostname and TLS. Do not
describe the deployment as HTTPS or production-hardened on a resume until that
is actually complete.

### Operations

```bash
docker compose ps
docker compose logs --tail=100 api
docker compose logs --tail=100 db
docker compose pull
docker compose up -d --build
```

Back up the `pgdata` volume before instance replacement or destructive database
maintenance. EC2 termination and EBS deletion settings should be reviewed
before relying on the host for durable data.

## Alternative Managed-Platform Deployment

If maintaining a single EC2 host stops being useful, an alternative deployment
shape is:

- static frontend on something like Vercel, Netlify, or Cloudflare Pages
- containerized FastAPI backend and paper-runner worker on something like Render, Fly.io, or Railway
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
3. Deploy a second service from the same image with `python paper_runner_worker.py` as its command.
4. Use a managed Postgres instance with Timescale support if available.
5. Point both backend processes at that DB with `DATABASE_URL`.
6. Add a frontend rewrite or proxy so `/api/*` reaches the backend.

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

The API and paper runner deliberately use separate processes. The API records
runner intent; `paper_runner_worker.py` acquires expiring PostgreSQL leases and
advances sessions. Do not run paper execution inside Uvicorn workers. Multiple
runner replicas are safe because lease acquisition is atomic, but one replica
is enough for the current workload.

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
