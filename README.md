<!-- @file-guide
목적: taco_office_back (document)
책임/재사용: 이 문서의 주제만 기록하고 공통 지시는 docs/AGENT.md, 현재 작업은 docs/CLAUDE.md를 연결한다. 과거 수치를 현행 완료로 복제하지 않는다.
검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
-->

# taco_office_back

TACO ERP API — **NestJS 11 · TypeORM · Neon Postgres · Vercel**

> 문서 정본은 형제 저장소 [`docs/AGENT.md`](../docs/AGENT.md)와 [`DEV-SPEC.md`](../docs/spec/DEV-SPEC.md) (v2 · 실제 UI 61컷)입니다.
> [`STACK`](../docs/contracts/STACK.md) · [`CONTRACTS`](../docs/contracts/CONTRACTS.md) · [`ERD`](../docs/contracts/db/erd.dbml)
> 경로는 back/front/docs가 같은 부모 폴더에 있는 로컬 워크스페이스 기준입니다. 단독 clone에서는 docs 저장소도 준비합니다.

**프론트와는 독립 레포다** (D-R42). 공유하는 것은 코드가 아니라 `openapi.json` 한 장이다.

---

## 시작

```bash
cp .env.local.example .env.local     # 기존 파일이 없을 때만. 로컬 DB/CORS 설정 확인
npm ci                              # 현재 OS/CPU에서 기존 lockfile로 설치
npm run dev                          # http://localhost:3001/api/docs
```

`.env.local` 의 키가 하나라도 없으면 **부팅이 막힌다** (`app.module.ts` 의 Joi 스키마).
반쯤 뜬 서버가 가장 고치기 어렵다.

**기존 `.env.local`은 운영 Neon을 가리킬 수 있습니다.** migration·seed·DB 테스트 전에 대상을 확인합니다.
전체 검증은 워크스페이스에서 `zsh docs/script/release.zsh --check --sync-contracts`를 권장합니다.
이 경로가 임시 PostgreSQL의 개발/`_test` DB를 준비합니다. 운영 migration은 preflight·승인·readback을 별도로 거칩니다.

## 이 레포에서 지키는 것

| 규칙 | 어디에 | 어기면 |
|---|---|---|
| **권한은 세 줄에서만 판정** (D-R39) | `src/common/perm` | eslint 가 `role ===` 비교를 막는다 |
| **정산 조건은 「썼는가」 하나** (D-R7) | `src/lib/rules.ts` `countsForSettlement` | 테스트 7개가 빨개진다 |
| **지각 차감은 수업 종료 시각 기준** (D-R32) | `src/lib/rules.ts` `LATE_REPORT_TIERS` | 경계값 테스트 7개 |
| **겹침은 DB 가 막는다** (D-R43) | `src/migrations` 의 `EXCLUDE` 제약 | 동시성 테스트 8개 |
| **DTO 가 단일 출처** | `openapi.json` 생성물 | `npm run openapi:check` 가 CI 에서 막는다 |
| **스키마는 마이그레이션으로만** | `synchronize: false` | — |

## 명령

| | |
|---|---|
| `npm run dev` | 개발 서버 (`/api/docs` 에 Swagger) |
| `npm test` | `.env.local`도 읽음. DB 테스트는 `DATABASE_URL`/`TEST_DATABASE_URL` 대상 확인 필수; 미설정 skip은 검증 통과가 아님 |
| `npm run typecheck` · `npm run lint` | 타입 · 린트 |
| `npm run migration:run` · `migration:revert` | 스키마 |
| `npm run openapi:gen` | `openapi.json` 갱신 — **DTO 를 고쳤으면 같은 커밋에** |
| `npm run openapi:check` | 생성물이 DTO 와 같은지 (CI) |
| `bash scripts/entities-gen.sh` | 레거시 생성기. 현재 수기 CHECK/타입 보강을 덮을 수 있어 무차별 재생성 금지 |

## 생성물과 스키마

- `src/entities/**`는 ERD에서 시작했지만 현재 수기 제약·타입 보강을 포함한다. entity·ERD·snapshot·forward migration을 같은 청크에서 대조한다.
- `openapi.json`은 DTO 생성물이며 손으로 고치지 않는다.

## 아직 없는 것

| | 왜 |
|---|---|
| GPA 4표 | **N-13** 결정 대기 — 별표로 뺄지 `SER(kind='gpa')` 에 얹을지 |
| `nestjs-pino` | **§11-A** 2026-08-31 승인 완료, 도입 잔여 |
| `typeorm-transactional` | **§11-B** 승인 완료, 도입 잔여. 현재 QueryRunner transaction·행 lock·DB 제약 사용 |
| 미완 업무 쓰기 | 컨설팅 항목/단계·상담·회계·운영 등. 최신 목록은 [MVP 잔여](../docs/report/MVP-REMAINING-PLAN-2026-09-04.md) |
