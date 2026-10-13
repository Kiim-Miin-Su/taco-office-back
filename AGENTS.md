<!-- @file-guide
목적: 문서 및 에이전트 작업 안내
책임/재사용: 이 파일의 범위만 설명한다. 업무 규칙은 docs/AGENT.md, 현재 작업은 docs/CLAUDE.md를 따른다.
검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
-->

# Backend 작업 지침

[공통 지침](../AGENTS.md)과 [업무 정본](../docs/AGENT.md)을 전제로 NestJS API·도메인·영속 계층을 다룬다.

## 환경·폴더

- Node `>=22`, npm, NestJS 11, strict TypeScript(CommonJS), TypeORM/PostgreSQL. 현재 compiler·Jest·ESLint 설정을 유지한다.
- `src/modules/{도메인}`에 module/controller/service/dto가 함께 있다. Java package/DAO 계층을 추가하지 않는다.
- `src/auth`: 인증·쿠키·온보딩. `src/common/perm`: 권한. `src/lib`: 공유 규칙. `src/entities`: DB 매핑. `src/migrations`: 이행 이력. `test`: 회귀.
- `@/*` alias는 tsconfig에서 확인하되 실행 경로의 해석 지원도 확인한다. 기존 상대 import를 별칭으로 일괄 바꾸지 않는다.
- 신규 별도 앱만 공식 Nest CLI로 만든다. 기존 앱 재생성·최신 CLI 기본 ESM/runner/linter로의 자동 교체는 하지 않는다.

## HTTP·DTO·서비스

- `src/app.factory.ts`는 로컬/서버리스 공통 설정 소유자다. main/serverless에 pipe·CORS·cookie·guard를 중복 구성하지 않는다.
- controller는 HTTP DTO·Swagger·Perm 메타데이터와 service 연결만 담당한다. constructor `private readonly` 주입과 기존 반환형을 유지한다.
- DTO는 class-validator/class-transformer와 Swagger를 함께 정의한다. 필수/optional/nullable, enum, 중첩 배열, `undefined=유지`/`null=삭제`를 실제 service 동작과 맞춘다.
- entity를 그대로 응답하지 않는다. 읽기는 권한별 projection, 쓰기는 서버의 현재 actor·capability·도메인 방어를 적용한다. `role` 직접 비교는 common/perm 밖에서 금지한다.
- 업무 규칙은 기존 lib/service 소유자를 찾는다. SQL은 parameter binding을 사용하며 입력으로 table/column/order 문자열을 직접 조합하지 않는다.
- 하나의 업무 transaction에 속한 DB 작업은 같은 manager/QueryRunner를 사용한다. 일반 조회까지 불필요하게 transaction으로 감싸지 않고 필요한 일관성 수준을 확인한다. 업무 행·HIST/NOTI·멱등 receipt의 원자성과 행 lock·제약 순서를 유지한다. 앱 사전검사만으로 동시성 안전을 주장하지 않는다.
- 예외는 기존 코드 체계와 필터로 변환한다. 공개 응답은 현재 `ApiErrorDto`와 필터 형상을 따른다. 임의 detail·stack·DB 오류를 노출하지 않는다.
- DTO/Swagger → OpenAPI → Front generated schema를 같은 청크에서 대조한다. `openapi.json`은 손편집하지 않는다.

## DB·로그·보안

- `synchronize:false`, `migrationsRun:false`를 유지한다. entity/DBML/forward migration/실제 DB 제약을 대조한다. [migration 지침](src/migrations/AGENTS.md)을 먼저 읽는다.
- entity에는 수기 타입·제약 보강이 있다. 레거시 `entities-gen.sh`로 전체 덮어쓰지 않는다.
- 현행 로거는 Nest Logger다. 빈 `src/common/logger/`를 이미 구현된 로깅 모듈로 가정하거나 pino/transactional 의존성을 임의 도입하지 않는다.
- 기존 HTTP diagnostics는 서버 발급 requestId·route template·status·duration·허용 코드 등 최소 필드만 남긴다. raw request/response/exception·URL query·인증·개인정보 원문은 제외한다.
- 위험한 로그를 추가하기보다 재현 조건과 허용된 metadata로 진단한다. 작업 중인 diagnostics 사용자 변경은 보존한다.

## 검증

코드·설정 변경일 때 저장소에서 `npm run typecheck`, `npm run lint`, `npm run build`를 실행한다. build는 dist를 재생성한다. 문서-only는 상위 문서 검증 범위를 따른다.
관련 단위/HTTP/DB 회귀는 [test 지침](test/AGENTS.md)에 따라 선택한다. 전체 Jest·OpenAPI·schema 검사는 DB 대상 확인 뒤 실행한다.

`openapi:gen`과 `openapi:check`는 모두 앱을 부팅하고 DB에 연결한다. shell에 명시한 격리 `DATABASE_URL`이 필요하다. `--check`를 오프라인 검사로 취급하지 않는다.

`npm run db`는 migration과 seed reset을 포함한다. migration/revert/dryrun/seed/reprice/reconcile/archive/reset/deploy 계열을 무조건 실행하지 않는다. 이름·플래그·`_test` suffix는 대상 확인·삭제 권한·백업을 대신하지 않는다.

## 작업 스킬

- [.agents/skills/taco-nest-api](.agents/skills/taco-nest-api/SKILL.md): Nest 기능·DTO·HTTP 회귀.
- [.agents/skills/taco-postgres-change](.agents/skills/taco-postgres-change/SKILL.md): DB 변경·격리 검증·이행.
- 교차 저장소 계약/검증은 [공통 스킬](../.agents/README.md)을 따른다.
