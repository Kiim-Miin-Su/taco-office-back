#!/usr/bin/env bash
# 개발용 Postgres 한 번에 — 띄우고 · 표 만들고 · 시드 넣고 · 확인한다.
#
# 이 컴퓨터에 Postgres 가 없어도 EXCLUDE 제약과 tstzrange 를 **진짜 엔진에서** 확인하려고 둔다.
# Neon 이 연결되면 DATABASE_URL 만 바꾸면 되고 이 스크립트는 필요 없어진다.
#
#   ./scripts/dev-db.sh up      띄우고 마이그레이션 + 시드까지
#   ./scripts/dev-db.sh reset   시드만 다시
#   ./scripts/dev-db.sh stop
#   ./scripts/dev-db.sh doctor  이 컴퓨터에서 돌 수 있는 상태인지만 확인
#   ./scripts/dev-db.sh urls    개발 · 테스트 DB 주소를 찍는다
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"

# 플랫폼은 **지금 이 컴퓨터**에서 읽는다. 여기를 고정하면 다른 OS 에서 통째로 깨진다.
PKG="${EPG_PKG:-$(node -p '
const p = { darwin: "darwin", win32: "windows" }[process.platform] || "linux";
const c = { arm64: "arm64", x64: "x64", arm: "arm", ia32: "ia32", ppc64: "ppc64" }[process.arch] || process.arch;
p + "-" + c;')}"
BIN="$ROOT/node_modules/@embedded-postgres/$PKG/native/bin"
DATA="${PGDATA_DIR:-$HOME/pgdata}"; PORT="${PGPORT:-55432}"
export LD_LIBRARY_PATH="$BIN/../lib:${LD_LIBRARY_PATH:-}"
export DYLD_LIBRARY_PATH="$BIN/../lib:${DYLD_LIBRARY_PATH:-}"
export DATABASE_URL="postgresql://taco:taco@localhost:$PORT/taco_dev"
# 표를 비우는 테스트(concurrency.spec)는 개발 DB 가 아니라 여기서 돈다.
# 같은 DB 를 쓰면 npm test 한 번에 시드가 사라진다 — test/db.ts 참고.
export TEST_DATABASE_URL="postgresql://taco:taco@localhost:$PORT/taco_dev_test"
export ROOT PORT

# node_modules 가 **다른 OS 것**이면 여기서 잡는다.
# ELF 를 macOS 에서 실행하면 "cannot execute binary file" 만 나오고 원인이 안 보인다.
preflight() {
  local other
  if [ ! -x "$BIN/initdb" ] || ! "$BIN/initdb" --version >/dev/null 2>&1; then
    other="$(ls -d "$ROOT"/node_modules/@embedded-postgres/*/native/bin 2>/dev/null | head -1 || true)"
    echo "✗ 이 컴퓨터($PKG)용 postgres 바이너리가 없다." >&2
    echo "  찾은 곳: $BIN" >&2
    [ -n "$other" ] && echo "  대신 깔린 것: $(echo "$other" | sed 's#.*@embedded-postgres/##; s#/native/bin##') — 다른 OS 용이다." >&2
    echo "" >&2
    echo "  node_modules 를 이 컴퓨터에서 다시 깔면 된다:" >&2
    echo "    rm -rf node_modules && npm install" >&2
    exit 1
  fi
  if ! node -e 'require("bcryptjs")' >/dev/null 2>&1; then
    echo "✗ bcryptjs 를 불러올 수 없다 — node_modules 설치 상태를 확인해야 한다." >&2
    echo "    rm -rf node_modules && npm install" >&2
    exit 1
  fi
}

q() { DB="${DB:-postgres}" node -e '
const {Client}=require(process.env.ROOT+"/node_modules/pg");
(async()=>{const c=new Client({host:"localhost",port:+process.env.PORT,user:"taco",password:"taco",database:process.env.DB});
await c.connect();const r=await c.query(process.argv[1]);
if(r.rows.length)console.log(r.rows.map(x=>Object.values(x).join("  ")).join("\n"));await c.end();})()
.catch(e=>{console.error(e.message);process.exit(1);});' "$1"; }

start() {
  preflight
  # 비밀번호 파일은 mktemp 로 만든다 — /tmp/pgpw 로 고정하면 남의 것이 남아 있을 때 막힌다.
  [ -f "$DATA/PG_VERSION" ] || {
    mkdir -p "$DATA"; PW="$(mktemp)"; echo taco > "$PW"
    "$BIN/initdb" -D "$DATA" -U taco --pwfile="$PW" -E UTF8 >/dev/null; rm -f "$PW"
  }
  "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/server.log" -w start >/dev/null 2>&1 || true
  for _ in $(seq 1 25); do q "select 1" >/dev/null 2>&1 && break; sleep 0.4; done
  q "select 1" >/dev/null || { tail -5 "$DATA/server.log"; exit 1; }
  for db in taco_dev taco_dev_test; do
    if ! q "select 1 from pg_database where datname='$db'" | grep -q 1; then q "create database $db" >/dev/null; fi
  done
  echo "postgres up — port $PORT · db taco_dev + taco_dev_test · $PKG"
}

case "${1:-up}" in
  up)
    start
    echo "── 마이그레이션 (개발)"; npm run --silent migration:run 2>&1 | grep -E "migrations|Migration|error|Error" | tail -3
    echo "── 마이그레이션 (테스트)"; DATABASE_URL="$TEST_DATABASE_URL" npm run --silent migration:run 2>&1 | grep -E "migrations|Migration|error|Error" | tail -3
    echo "── 시드";        npx --yes ts-node -P tsconfig.json scripts/seed.ts --reset 2>&1 | tail -14
    ;;
  reset) start; npx --yes ts-node -P tsconfig.json scripts/seed.ts --reset 2>&1 | tail -14 ;;
  start) start ;;
  stop)  "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true; echo stopped ;;
  q)     shift; start >/dev/null; DB=taco_dev q "$1" ;;
  doctor) preflight; echo "✓ $PKG · postgres $("$BIN/initdb" --version | awk '{print $NF}') · bcryptjs ok" ;;
  urls)  echo "DATABASE_URL=$DATABASE_URL"; echo "TEST_DATABASE_URL=$TEST_DATABASE_URL" ;;
esac
