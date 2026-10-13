---
name: taco-postgres-change
description: TACO PostgreSQL/TypeORM entity·제약·migration·DB 영속화 변경을 설계하거나 검증할 때 사용한다. 운영 적용이나 데이터 삭제 권한을 자동으로 부여하지 않는다.
---

<!-- @file-guide
목적: 문서 및 에이전트 작업 안내
책임/재사용: 이 파일의 범위만 설명한다. 업무 규칙은 docs/AGENT.md, 현재 작업은 docs/CLAUDE.md를 따른다.
검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
-->

# PostgreSQL 변경

설계·조사·리뷰만 요청하면 소스 매핑·위험·검증 계획까지 보고한다. migration 작성·생성물 변경은 구현 요청이 있을 때, DB 실행은 확인된 대상·허가 범위 안에서만 수행한다.

1. Back AGENTS, src/migrations/AGENTS, test/AGENTS를 읽는다. 현재 entity·DBML·snapshot·migration·writer/reader와 실패 조건을 연결한다.
2. 조회 projection/계산으로 해결되는지 먼저 확인한다. 스키마가 필요하면 기존 행·참조·null/중복·index·잠금·호환 순서를 설계한다.
3. 폐기 가능한 로컬 DB의 host/name/branch·소유권·삭제 허가·두 DATABASE_URL 환경을 확인한다. URL 원문을 출력하지 않는다. 확인 실패 시 DB 명령을 실행하지 않는다.
4. 적용 이력은 보존하고 새 forward migration을 작성한다. up/down·비가역 데이터·백업/복구·transaction 경계를 명시한다.
5. dry-run도 DDL/lock을 실행함을 전제로 fresh/upgrade·실패 rollback·직접 SQL 제약·동시성·조회 회귀를 검증한다. 자신의 fixture만 정리한다.
6. entity/DBML current+snapshot·schema 검사·필요한 DTO/생성 계약과 기능 문서를 대조한다. schema check에 필요한 DB 대상도 확인한다.
7. 운영/Preview 적용은 별도 승인과 identity·격리·backup·호환 배포·readback·rollback 증거가 필요하다. Neon branch READY 또는 `_test` 이름은 이를 대신하지 않는다.

`db`, `seed --reset`, `migration:revert`, `golive:reset` 등을 관성적으로 실행하지 않는다. 기존 외부 Neon 스킬은 해당 서비스 작업이 필요할 때만 읽고 제품 미도입 기능을 추가하지 않는다.
