#!/usr/bin/env bash
# 개발용 Postgres 한 번에 — 띄우고 · 표 만들고 · 시드 넣고 · 확인한다.
#
# 이 컴퓨터에 Postgres 가 없어도 EXCLUDE 제약과 tstzrange 를 **진짜 엔진에서** 확인하려고 둔다.
# Neon 이 연결되면 DATABASE_URL 만 바꾸면 되고 이 스크립트는 필요 없어진다.
#
#   ./scripts/dev-db.sh up      띄우고 마이그레이션 + 시드까지
#   ./scripts/dev-db.sh reset   시드만 다시
#   ./scripts/dev-db.sh stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
ARCH="linux-$(node -p "process.arch === 'arm64' ? 'arm64' : 'x64'")"
BIN="$ROOT/node_modules/@embedded-postgres/$ARCH/native/bin"
DATA="${PGDATA_DIR:-$HOME/pgdata}"; PORT="${PGPORT:-55432}"
export LD_LIBRARY_PATH="$BIN/../lib:${LD_LIBRARY_PATH:-}"
export DATABASE_URL="postgresql://taco:taco@localhost:$PORT/taco_dev"
export ROOT PORT

q() { DB="${DB:-postgres}" node -e '
const {Client}=require(process.env.ROOT+"/node_modules/pg");
(async()=>{const c=new Client({host:"localhost",port:+process.env.PORT,user:"taco",password:"taco",database:process.env.DB});
await c.connect();const r=await c.query(process.argv[1]);
if(r.rows.length)console.log(r.rows.map(x=>Object.values(x).join("  ")).join("\n"));await c.end();})()
.catch(e=>{console.error(e.message);process.exit(1);});' "$1"; }

start() {
  [ -f "$DATA/PG_VERSION" ] || { mkdir -p "$DATA"; echo taco > /tmp/pgpw; "$BIN/initdb" -D "$DATA" -U taco --pwfile=/tmp/pgpw -E UTF8 >/dev/null; }
  "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/server.log" -w start >/dev/null 2>&1 || true
  for _ in $(seq 1 25); do q "select 1" >/dev/null 2>&1 && break; sleep 0.4; done
  q "select 1" >/dev/null || { tail -5 "$DATA/server.log"; exit 1; }
  if ! q "select 1 from pg_database where datname='taco_dev'" | grep -q 1; then q "create database taco_dev" >/dev/null; fi
  echo "postgres up — port $PORT · db taco_dev"
}

case "${1:-up}" in
  up)
    start
    echo "── 마이그레이션"; npm run --silent migration:run 2>&1 | grep -E "migrations|Migration|error|Error" | tail -3
    echo "── 시드";        npx --yes ts-node -P tsconfig.json scripts/seed.ts --reset 2>&1 | tail -14
    ;;
  reset) start; npx --yes ts-node -P tsconfig.json scripts/seed.ts --reset 2>&1 | tail -14 ;;
  start) start ;;
  stop)  "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true; echo stopped ;;
  q)     shift; start >/dev/null; DB=taco_dev q "$1" ;;
esac
