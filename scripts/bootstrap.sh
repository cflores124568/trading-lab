#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
BACKEND_ENV_FILE="$BACKEND_DIR/.env"
BACKEND_ENV_TEMPLATE="$BACKEND_DIR/env.example"
PARQUET_DIR="$BACKEND_DIR/data/futures_1m"
DB_CONTAINER_NAME="trading_lab_db"
DB_HEALTH_TIMEOUT_SECONDS=120

log() {
  printf '[bootstrap] %s\n' "$1"
}

fail() {
  printf '[bootstrap] ERROR: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

resolve_python() {
  if [[ -x "$BACKEND_DIR/venv/bin/python" ]]; then
    printf '%s\n' "$BACKEND_DIR/venv/bin/python"
    return
  fi

  if command_exists python3; then
    printf 'python3\n'
    return
  fi

  if command_exists python; then
    printf 'python\n'
    return
  fi

  fail "Python is required to run the migration script."
}

resolve_compose() {
  if docker compose version >/dev/null 2>&1; then
    printf 'docker compose\n'
    return
  fi

  if command_exists docker-compose; then
    printf 'docker-compose\n'
    return
  fi

  fail "Docker Compose is required. Install Docker Desktop or docker-compose."
}

ensure_backend_env() {
  if [[ -f "$BACKEND_ENV_FILE" ]]; then
    if grep -q '^DATABASE_URL=.*@postgres:' "$BACKEND_ENV_FILE"; then
      perl -0pi -e 's#^DATABASE_URL=postgresql://trading:trading@postgres:5432/trading_lab$#DATABASE_URL=postgresql://trading:trading@localhost:5432/trading_lab#m' "$BACKEND_ENV_FILE"
      log "Updated $BACKEND_ENV_FILE to use localhost for local DB access"
    fi
    return
  fi

  if [[ ! -f "$BACKEND_ENV_TEMPLATE" ]]; then
    fail "Missing backend env template at $BACKEND_ENV_TEMPLATE"
  fi

  cp "$BACKEND_ENV_TEMPLATE" "$BACKEND_ENV_FILE"
  if grep -q '^DATABASE_URL=.*@postgres:' "$BACKEND_ENV_FILE"; then
    perl -0pi -e 's#^DATABASE_URL=postgresql://trading:trading@postgres:5432/trading_lab$#DATABASE_URL=postgresql://trading:trading@localhost:5432/trading_lab#m' "$BACKEND_ENV_FILE"
  fi
  log "Created $BACKEND_ENV_FILE from env.example"
  log "Review DATABASE_URL, ALLOWED_ORIGINS, and DATABENTO_API_KEY before running the API."
}

wait_for_db_health() {
  local started_at now status
  started_at="$(date +%s)"

  while true; do
    status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$DB_CONTAINER_NAME" 2>/dev/null || true)"

    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      log "Database container is $status"
      return
    fi

    now="$(date +%s)"
    if (( now - started_at >= DB_HEALTH_TIMEOUT_SECONDS )); then
      fail "Timed out waiting for $DB_CONTAINER_NAME to become healthy."
    fi

    sleep 2
  done
}

has_parquet_data() {
  [[ -d "$PARQUET_DIR" ]] && find "$PARQUET_DIR" -maxdepth 1 -name '*.parquet' -print -quit | grep -q .
}

run_migration() {
  local python_cmd
  python_cmd="$(resolve_python)"

  log "Importing parquet files into TimescaleDB"
  (
    cd "$BACKEND_DIR"
    "$python_cmd" db/migrate_parquet_to_pg.py
  )
}

main() {
  local compose_cmd

  command_exists docker || fail "Docker is required. Install Docker Desktop first."

  ensure_backend_env

  compose_cmd="$(resolve_compose)"

  log "Starting local TimescaleDB with Docker"
  (
    cd "$BACKEND_DIR"
    if [[ "$compose_cmd" == "docker compose" ]]; then
      docker compose up -d db
    else
      docker-compose up -d db
    fi
  )

  wait_for_db_health

  if has_parquet_data; then
    run_migration
  else
    log "No local parquet files found at $PARQUET_DIR"
    log "Fetch data later with: cd $BACKEND_DIR && python fetch_databento.py --start 2024-01-01"
  fi

  log "Bootstrap complete"
  log "Next steps:"
  log "  1. Backend: cd $BACKEND_DIR && uvicorn main:app --reload"
  log "  2. Paper worker: cd $BACKEND_DIR && ./venv/bin/python paper_runner_worker.py"
  log "  3. Frontend: cd $ROOT_DIR/frontend && npm run dev"
}

main "$@"
