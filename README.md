<!-- @file-guide
목적: 문서 및 에이전트 작업 안내
책임/재사용: 이 파일의 범위만 설명한다. 업무 규칙은 docs/AGENT.md, 현재 작업은 docs/CLAUDE.md를 따른다.
검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
-->

# taco_office_back

## 프로젝트 개요

TACO ERP의 **NestJS 11 · TypeScript · TypeORM · PostgreSQL/Neon** API입니다. 프론트엔드와 독립된 저장소이며 DTO/Swagger에서 생성하는 `openapi.json`이 공유 계약입니다.

[작업 지침](AGENTS.md) · [업무 정본](../docs/AGENT.md) · [현재 인계](../docs/CLAUDE.md) · [API 계약](../docs/contracts/CONTRACTS.md) · [ERD](../docs/contracts/db/erd.dbml)

## 제공 기능

인증·권한, 일정·출결·리포트, 학생·강사, 상담·등록·컨설팅, 교재·안내, 회계·정산·운영, 알림·요청·파일 등의 서버 계약을 소유합니다. 상태 전이·권한별 응답·transaction·DB 제약을 서버에서 검증합니다.
기능별 구현/검증/운영 적용은 [기능 대조표](../docs/contracts/FEATURE-CRUD-MAP.md)로 확인합니다. 과거 미완 목록을 현재 구현 부재로 해석하지 않습니다.

## 실행환경 구축

Node.js `>=22`, npm, 격리된 PostgreSQL 개발/시험 DB를 준비합니다. 정확한 버전은 package/lockfile이 소유합니다. 개발 컴퓨터의 OS/CPU에서 설치하며 다른 환경의 node_modules를 복사하지 않습니다.

```sh
npm ci
test -e .env.local || cp .env.local.example .env.local
npm run db:doctor
```

`db:doctor`는 로컬 바이너리·bcrypt 진단이며 DB 생성/접속 확인이 아닙니다.
기존 `.env.local`은 원격 DB를 가리킬 수 있습니다. 덮어쓰지 말고 비밀값을 출력하지 않은 채 대상과 용도를 확인합니다.

| 키 | 조건 |
|---|---|
| `DATABASE_URL` | 앱 필수. 명시적 격리 개발 DB |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | 앱 필수, 서로 구분한 로컬 비밀값. 최소 길이는 Joi 스키마 확인 |
| `TEST_DATABASE_URL` | DB 시험 시 명시적 폐기 가능한 로컬 시험 DB |
| `CORS_ORIGIN` | production 필수. 실제 Front origin |
| `PORT`, `NODE_ENV`, `LOG_LEVEL` | 기존 기본값·허용값은 `src/app.module.ts` 확인 |
| 쿠키·암호화·발송·파일 키 | `.env.local.example`와 기능별 실제 설정 확인 |

앱은 `.env.local` → `.env`를 읽으며 기존 shell 값이 우선합니다. 모든 키가 필수인 것은 아니고 기능별 추가 조건이 있습니다.

**DB 준비는 별도 데이터 변경입니다.** `npm run db` 기본 경로는 DB 생성·migration·seed reset까지 수행합니다. 이미 있는 데이터를 지워도 되는지 확인하기 전 실행하지 않습니다. `_test` 이름만으로 운영/원격 안전을 증명할 수 없습니다.

## 빌드 방법

```sh
npm run typecheck
npm run lint
npm run build
```

Nest 빌드는 `dist/`를 다시 만듭니다. 컴파일 통과는 실제 DB schema·인증·외부 서비스·배포 검증과 별개입니다.

## 주요 사용 기술

NestJS(Express), TypeORM/pg, class-validator/class-transformer, Swagger, Joi/config, JWT/Passport/bcryptjs, Nest Logger, Jest/ts-jest/Supertest를 사용합니다. 메일은 nodemailer, 일반 파일·기존 교재 본문은 Neon `FILE`이 담당합니다. 신규 교재 SE/TE PDF 본문은 private Vercel Blob에 직접 올리고 Neon에는 파일·권한 메타데이터를 저장합니다. 파일당 1GB, 한 판 합계 2GB이며 일반 DB 파일의 3MB 제한은 유지합니다. 기존 업로드 의도에 대해 `POST /files/book-pdf-presigned`가 소유자·만료·정확한 경로·bytes를 다시 검사하여 SDK multipart 권한을 발급합니다. Blob 배포에는 해당 private store의 `BLOB_READ_WRITE_TOKEN`과 `BLOB_WEBHOOK_PUBLIC_KEY`가 필요하며 공개 키 누락은 안전한 503으로 거절합니다. 전진 migration126은 로컬 폐기 DB에서 검증했으며 원격 DB에는 아직 적용하지 않았습니다. [1GB 기능 원장](../docs/sprint/TBO-55/features/BOOK-PDF-1GB-2026-10-13.md)을 확인합니다. 만료된 미사용 교재 업로드는 `DATABASE_URL=<검증한 대상> npm run book-pdf:cleanup`으로 건수를 조회하고, 대상 DB명과 삭제 권한을 확인한 뒤 `-- --run --database=<DB명>`으로 최대 100건씩 정리합니다. 운영 실행 주기와 실제 Blob PUT/GET은 별도 출하 검증 대상입니다.

현행 구현은 TypeORM transaction과 DB 제약을 사용합니다. `nestjs-pino`나 `typeorm-transactional`을 도입된 의존성으로 가정하지 않습니다. 권한 helper는 `src/common/perm`이 소유하며 다른 계층에서 role을 직접 비교하지 않습니다.

## 실행방법

환경과 개발 DB를 준비한 뒤 실행합니다.

```sh
npm run dev
```

기본 API는 `http://localhost:3001/api/v1`, health는 `/api/v1/health`, 개발 Swagger는 `/api/docs`입니다.
운영 Swagger 노출은 `ENABLE_DOCS`와 기존 부팅 설정을 확인합니다. 빌드 결과는 `npm start`로 실행하며 production 환경과 쿠키/CORS 조건을 확인합니다.

## 폴더 구조

```text
src/
  app.factory.ts   로컬/서버리스 공통 앱 설정
  main.ts          로컬 서버
  serverless.ts    서버리스 진입
  auth/            인증·쿠키·온보딩
  common/          validation·권한·오류·진단
  modules/{도메인}/
    *.module.ts    의존성 연결
    *.controller.ts HTTP·DTO·권한 메타데이터
    *.service.ts   업무 규칙·조회/쓰기
    *.dto.ts       요청·응답·Swagger/검증
  lib/             공유 도메인 함수
  entities/        영속 레코드 매핑
  migrations/      forward 이행 이력
  seed/            개발 fixture
test/              단위·HTTP·DB 회귀
scripts/           생성·DB·운영 도구
.agents/skills/    API·DB 작업 스킬
```

Java 기본 패키지 대신 `src/` 모듈 경계를 유지합니다. 엔티티는 수기 제약·타입 보강을 포함하므로 레거시 생성기로 전체 덮어쓰지 않습니다. `synchronize:false`와 migration 기반 변경을 유지합니다.

## 검증·계약 생성

| 명령 | 조건 |
|---|---|
| `npm test -- --runInBand --runTestsByPath test/perm.spec.ts` | DB-free 권한 단위시험 예시 |
| `npm test -- --runInBand` | 전체 Jest, **두 DB 대상·fixture 삭제 범위·발송 격리 확인 후** |
| `npm run openapi:gen` / `npm run openapi:check` | 명시적 shell DATABASE_URL 필수. **둘 다 앱 부팅·DB 접속** |
| Front의 `npm run types:gen` | 검증한 OpenAPI에서 Front schema 재생성 |
| `npm run schema:check` | 실제 DB 접속 후 entity/DB 대조 |

OpenAPI/schema 생성물은 손편집하지 않습니다. DTO·Swagger·service 동작 → OpenAPI → Front alias/consumer → 테스트를 같은 청크에서 확인합니다.
DB suite의 미설정 skip은 검증 통과가 아닙니다. 자세한 실행 경계는 [test/AGENTS](test/AGENTS.md)를 따릅니다.

migration/run/revert/deploy, seed/reset, reprice/reconcile/archive는 실제 데이터 영향이 있습니다.
`migration:dryrun`도 rollback 전 DDL/lock을 실행합니다. 문서 확인이나 일반 개발 시작 명령으로 실행하지 않습니다.
운영 작업은 대상 identity·백업·승인·호환성·readback·rollback을 별도로 확인합니다.

## 신규 구성·문서화 원칙

모든 새 프레임워크 앱은 공식 CLI/스타터로 구성합니다. NestJS는 [Nest CLI](https://docs.nestjs.com/cli/overview), Next.js는 create-next-app, Spring Boot는 Spring Initializr입니다. 기존 앱을 재생성하거나 최신 생성기의 ESM/runner/linter로 자동 변경하지 않습니다.

구현과 함께 PROMPT·계약·DBML·Figma·portfolio를 기능 ID로 대조합니다. 실행 명령·실패/skip·미검증·운영 미적용을 구분해 보고합니다.
