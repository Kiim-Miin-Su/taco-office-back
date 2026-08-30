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
  // Vercel 서버리스는 인스턴스가 늘었다 줄었다 하므로 커넥션을 적게 쥔다
  extra: { max: 5 },
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false,
  logging: (process.env.LOG_LEVEL === 'debug'
    ? ['error', 'warn', 'migration']
    : ['error', 'migration']) as LogLevel[],
};

export default new DataSource(dataSourceOptions);
