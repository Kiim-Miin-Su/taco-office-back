---
name: taco-nest-api
description: TACO NestJS 기능·DTO·controller/service·권한 projection·HTTP 오류를 구현하거나 수정할 때 사용한다. 새 앱 생성·DB 운영 적용·단순 문서 수정은 제외한다.
---

<!-- @file-guide
목적: 문서 및 에이전트 작업 안내
책임/재사용: 이 파일의 범위만 설명한다. 업무 규칙은 docs/AGENT.md, 현재 작업은 docs/CLAUDE.md를 따른다.
검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
-->

# NestJS 기능 구현

1. Back AGENTS와 해당 modules/lib/common/perm·caller·DTO·테스트, Front input/생성 타입을 조사한다.
2. 기존 service/공용 규칙을 재사용하고 controller는 HTTP와 주입만 담당하게 한다. app.factory 공통 부팅·guard·pipe를 중복하지 않는다.
3. 입력 optional/null/undefined·enum·nested validator/Type·Swagger를 일치시킨다. service의 실제 요청 의미와 응답 projection을 먼저 확인한다.
4. 현재 actor/capability와 서버 소유 도메인 방어를 적용한다. 권한 없는 데이터는 응답에서 제외한다. raw entity·예외 detail을 외부로 보내지 않는다.
5. 쓰기의 transaction manager·row lock·DB 제약·멱등 receipt·HIST/NOTI 원자성을 유지한다. schema 변경은 taco-postgres-change로 분리한다.
6. 테스트 지침에 따라 unit/HTTP/실제 DB 회귀를 선택한다. 정상/거절/소유권/잘못된 상태·동시성을 검증하고 관련 typecheck/lint/build를 실행한다.
7. API 변경이면 taco-contract-sync로 DTO→OpenAPI→Front schema를 생성·검증한다. `openapi:check`에도 DB 연결 사전조건을 적용한다.
8. 계약·기능별 문서·Figma/portfolio 영향과 미검증 경계를 같은 청크에 기록한다.

진단/리뷰 요청이면 재현·finding까지만 수행한다. 라이브러리 추가·인증 구조 교체·운영 DB 변경은 자동 후속 작업이 아니다.
