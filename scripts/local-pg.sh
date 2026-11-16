#!/usr/bin/env bash
# Local Postgres for HOCK without containers (Homebrew postgresql@16).
#   bash scripts/local-pg.sh up      start the service, create role hock / db hock if missing
#   bash scripts/local-pg.sh reset   drop and recreate the public schema (the engine re-applies migrations on boot)
#   bash scripts/local-pg.sh down    stop the service
# DATABASE_URL=postgres://hock:hock@127.0.0.1:5432/hock
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@16/bin
export PATH="$PGBIN:$PATH"
URL=postgres://hock:hock@127.0.0.1:5432/hock
case "${1:-up}" in
  up)
    brew services start postgresql@16 >/dev/null
    for i in $(seq 1 30); do pg_isready -q -h 127.0.0.1 -p 5432 && break; sleep 1; done
    pg_isready -h 127.0.0.1 -p 5432
    psql postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='hock'" | grep -q 1 || psql postgres -qc "CREATE ROLE hock LOGIN PASSWORD 'hock';"
    psql postgres -tAc "SELECT 1 FROM pg_database WHERE datname='hock'" | grep -q 1 || psql postgres -qc "CREATE DATABASE hock OWNER hock;"
    echo "ready: $URL"
    ;;
  reset)
    psql "$URL" -qc "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    echo "schema reset"
    ;;
  down)
    brew services stop postgresql@16
    ;;
  *) echo "usage: $0 up|reset|down"; exit 2 ;;
esac
