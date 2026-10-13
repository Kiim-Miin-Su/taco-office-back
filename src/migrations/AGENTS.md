<!-- @file-guide
목적: 문서 및 에이전트 작업 안내
책임/재사용: 이 파일의 범위만 설명한다. 업무 규칙은 docs/AGENT.md, 현재 작업은 docs/CLAUDE.md를 따른다.
검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
-->

# Migration 안전 지침

[Backend 지침](../../AGENTS.md)을 따른다. 이 폴더의 기존 파일은 적용 이력이며 포맷/주석 정리 대상으로 삼지 않는다.

1. 먼저 entity·current DBML·snapshot·기존 migration·참조 writer/reader를 읽고 schema 변경이 정말 필요한지 확인한다. DTO 파생값을 이유로 컬럼을 추가하지 않는다.
2. 이미 적용된 migration을 수정·삭제·이름 변경하지 않는다. timestamp와 클래스명은 기존 규칙을 따라 **새 forward migration**으로 작성한다.
3. 대상 host/DB/branch·역할·격리 상태·백업·허가 범위를 확인한다. 자격증명 원문은 출력하지 않는다. 연결 문자열의 명칭이나 `_test`만으로 안전 판정하지 않는다.
4. 기존 행의 orphan/중복/null·FK·CHECK·UNIQUE·EXCLUDE·trigger·index·lock 시간을 검토한다. 누락 관계나 개인정보를 추측 이관하지 않는다.
5. up/down의 데이터 보존·비가역 조건·실패 rollback을 기록한다. dry-run도 실제 DDL/lock을 실행하므로 공유/운영 대상에서 자동 실행하지 않는다.
6. 폐기 가능한 로컬 DB에서 fresh apply, 기존 schema upgrade, 필요한 revert/reapply, 직접 제약 위반·동시 요청·재조회 회귀를 실행한다. 삭제 시험은 승인된 시험 데이터에 한정한다.
7. entity·DBML current/snapshot·계약·시나리오·출하 순서를 같은 청크에서 대조한다. 적용 결과 없이 문서 버전/운영 완료 도장을 올리지 않는다.

운영 적용·rollback은 별도 승인과 출하 절차가 필요하다. 문서 수정 요청은 migration 실행 권한이 아니다.
