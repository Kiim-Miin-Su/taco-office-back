#!/usr/bin/env bash
# docs/contracts/db/erd.dbml → src/entities/*.entity.ts
#
# 손으로 62표를 옮기면 반드시 어긋난다. dbml 이 정본이므로 여기서 읽어 만든다.
# GPA 4표는 N-13 결정 대기라 제외한다 (규칙 P-1).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DBML="${1:-$HERE/../../taco-office/docs/contracts/db/erd.dbml}"
[ -f "$DBML" ] || { echo "erd.dbml 을 찾지 못했습니다: $DBML"; exit 1; }
cp "$DBML" /tmp/erd.dbml
python3 "$HERE/dbml-parse.py"
python3 "$HERE/dbml-emit.py"
cp "$DBML" "$HERE/../src/entities/erd.dbml.snapshot"
echo "생성 완료 — 생성물을 손으로 고치지 마세요."
