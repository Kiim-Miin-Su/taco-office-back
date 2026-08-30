import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource, type DataSourceOptions, type LogLevel } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ENTITIES } from './entities';

/* ══ .env 를 **여기서** 읽는다 ═══════════════════════════════════════════
   `app.module.ts` 는 `ConfigModule.forRoot()` 를 부르기 **전에** 이 파일을 import 한다.
   그런데 `dataSourceOptions` 는 모듈 최상단 상수라 import 시점에 평가된다 —
   즉 ConfigModule 이 `.env.local` 을 읽기 전에 `process.env.DATABASE_URL` 을 본다.

   그래서 셸에 값이 없으면 `url: undefined` 가 되고, TypeORM 은 조용히
   **localhost:5432** 로 붙는다. 개발에서는 헷갈리는 실패로 끝나지만,
   운영(Neon)에서는 엉뚱한 곳을 보거나 부팅이 안 되는 자리다.

   마이그레이션 CLI(`typeorm-ts-node-commonjs -d src/data-source.ts`)도 이 파일만 읽으므로,
   여기서 한 번 읽어 두면 앱 · CLI · 시드가 **같은 파일을 같은 방식으로** 본다.
   이미 있는 값은 덮어쓰지 않는다 (dotenv 기본) — 셸이 항상 이긴다.                     */
dotenv.config({ path: '.env.local' });
dotenv.config();

/**
 * TypeORM DataSource — 마이그레이션 CLI 와 앱이 같은 설정을 쓴다.
 *
 * `synchronize` 는 **항상 false** 다. 스키마는 마이그레이션 파일로만 바뀐다.
 * 켜 두면 엔티티를 고칠 때마다 운영 DB 가 조용히 따라 바뀐다 — 되돌릴 수 없다.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres' as const,
  url: process.env.DATABASE_URL,
  entities: ENTITIES,
  // 글롭을 **이 파일 옆**으로 잡는다. 두 벌(`dist/**.js` + `src/**.ts`)을 함께 적으면
  // 컴파일본으로 뜬 서버가 `.ts` 원본까지 함께 읽어 들이다가
  // 「typeorm does not provide an export named 'MigrationInterface'」로 죽는다 —
  // 최신 node 가 그 `.ts` 를 ESM 으로 해석하기 때문이다. ts-node 면 src, 빌드본이면 dist 하나만 본다.
  migrations: [`${__dirname}/migrations/*{.ts,.js}`],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
  migrationsRun: false,
  /**
   * 커넥션 수 — **서버리스에서는 1 이 기본이다.**
   *
   * 람다 인스턴스 하나가 동시에 처리하는 요청은 하나뿐이라 풀을 크게 쥘 이유가 없다.
   * 그런데 인스턴스는 트래픽에 따라 수십 개로 늘어나므로, 인스턴스마다 5개씩 쥐면
   * Neon 의 커넥션 한도를 **인스턴스 수 × 5** 로 밀어붙이게 된다.
   * 상시 서버로 옮기는 날에는 `DB_POOL_MAX` 로 올린다.
   */
  extra: {
    max: Number(process.env.DB_POOL_MAX ?? (process.env.VERCEL ? 1 : 5)),
    // 웜 인스턴스가 오래 잡고 있던 커넥션이 서버 쪽에서 이미 끊겼을 수 있다
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  },
  /**
   * SSL — Neon 은 필수다. 호스트 이름으로 짐작하지 않고 **연결 문자열이 말하는 대로** 따른다.
   * `neon.tech` 만 보고 판단하면 커스텀 도메인이나 다른 관리형 Postgres 에서 조용히 평문이 된다.
   */
  ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(process.env.DATABASE_URL ?? '')
    ? { rejectUnauthorized: false }
    : false,
  logging: (process.env.LOG_LEVEL === 'debug'
    ? ['error', 'warn', 'migration']
    : ['error', 'migration']) as LogLevel[],
};

export default new DataSource(dataSourceOptions);
