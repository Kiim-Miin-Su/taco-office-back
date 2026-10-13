<!-- @file-guide
목적: 문서 및 에이전트 작업 안내
책임/재사용: 이 파일의 범위만 설명한다. 업무 규칙은 docs/AGENT.md, 현재 작업은 docs/CLAUDE.md를 따른다.
검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
-->

# Backend 테스트 지침

[Backend 지침](../AGENTS.md)을 따른다. 테스트의 실행 횟수보다 실패 조건과 검증 경계가 중요하다.

- 먼저 대상 test와 import·setup을 읽고 pure unit / HTTP / 실제 DB 시험을 구분한다. DB-free 예시는 `test/perm.spec.ts`다.
- `test/db.ts`가 `.env.local`을 읽고 미지정 TEST_DATABASE_URL을 개발 URL에서 파생한다. 자동 파생을 안전 보장으로 믿지 않는다.
- DB 시험은 명시적 **로컬 격리 DATABASE_URL + TEST_DATABASE_URL**과 실제 identity를 확인한 뒤 실행한다. `_test` suffix 검사만으로 원격 데이터 삭제를 허용하지 않는다.
- 테스트가 fixture를 쓰거나 truncate/cleanup을 하는지 확인한다. 다른 suite의 행을 지우지 말고 자신의 식별자로 한정한다. 전체 초기화는 폐기 가능한 DB에서만 한다.
- `setup-env.ts`의 발송 key 제거는 DB 격리를 대신하지 않는다. 메일/SMS/파일 외부 효과는 기존 대역을 사용한다.
- 버그 재현 → 최소 수정 → 해당 회귀 → 영향/전체 suite 순서로 검증한다. 기존 fixture/순서 오염 실패를 새 기능 통과 근거로 숨기지 않는다.
- 정상·권한 없음·다른 소유자·입력 경계·상태 전이·409 stale/idempotency·동시성·실패 후 DB 불변·재조회 중 적용 항목을 선택한다.
- mock 단위시험은 실제 PostgreSQL 제약/transaction 증거가 아니다. DB 미설정 skip은 PASS와 따로 센다.

실행 예시: `npm test -- --runInBand --runTestsByPath test/perm.spec.ts`.
전체 `npm test -- --runInBand`는 안전한 두 DB 대상과 fixture/발송 격리를 확인한 뒤에만 실행한다. 검증 결과에는 명령·대상 종류·통과/실패/skip·미실행 이유를 기록한다.
