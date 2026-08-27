import 'reflect-metadata';
import { DataSource, type DataSourceOptions, type LogLevel } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ENTITIES } from './entities';

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
  migrations: ['dist/migrations/*.js', 'src/migrations/*.ts'],
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
