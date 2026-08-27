# taco_office_back

TACO ERP API — **NestJS 11 · TypeORM · Neon Postgres · Vercel**

> 정본: [`docs/spec/DEV-SPEC.md`](../taco-office/docs/spec/DEV-SPEC.md) (개발 명세서 v2 · 화면 70컷)
> 스택: [`docs/contracts/STACK.md`](../taco-office/docs/contracts/STACK.md) · 계약: [`CONTRACTS.md`](../taco-office/docs/contracts/CONTRACTS.md)
> 스키마: [`erd.dbml`](../taco-office/docs/contracts/db/erd.dbml) **v4.2**

**프론트와는 독립 레포다** (D-R42). 공유하는 것은 코드가 아니라 `openapi.json` 한 장이다.

---

## 시작

```bash
cp .env.local.example .env.local     # 값을 채운다
npm install
npm run migration:run                # 스키마를 만든다
npm run dev                          # http://localhost:3001/api/docs
```

`.env.local` 의 키가 하나라도 없으면 **부팅이 막힌다** (`app.module.ts` 의 Joi 스키마).
반쯤 뜬 서버가 가장 고치기 어렵다.

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
| `npm test` | 전체 테스트. `DATABASE_URL` 이 없으면 DB 테스트는 건너뛴다 |
| `npm run typecheck` · `npm run lint` | 타입 · 린트 |
| `npm run migration:run` · `migration:revert` | 스키마 |
| `npm run openapi:gen` | `openapi.json` 갱신 — **DTO 를 고쳤으면 같은 커밋에** |
| `npm run openapi:check` | 생성물이 DTO 와 같은지 (CI) |
| `bash scripts/entities-gen.sh` | `erd.dbml` → 엔티티 재생성 |

## 생성물 — 손으로 고치지 않는다

- `src/entities/**` ← `docs/contracts/db/erd.dbml`
- `openapi.json` ← DTO

## 아직 없는 것

| | 왜 |
|---|---|
| GPA 4표 | **N-13** 결정 대기 — 별표로 뺄지 `SER(kind='gpa')` 에 얹을지 |
| `nestjs-pino` | **§11-A** 추천안 확인 대기 |
| `typeorm-transactional` | **§11-B** 추천안 확인 대기. 지금은 `ds.transaction()` 을 직접 쓴다 |
| 화면별 모듈 | 트랙 B (TBO-23~) |
