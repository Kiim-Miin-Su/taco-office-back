/** @file-guide
 * 목적: BO-13E GPA 역사 원장 trigger와 결정적 export/restore의 up/down·직접 DML·변조·복원 회귀를 검증한다. (test)
 * 책임/재사용: 격리 schema 안에서 migration과 lib를 그대로 실행하며 운영 DB 적용을 주장하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { GpaArchiveGuard1767300000000 } from '../src/migrations/1767300000000-gpa-archive-guard';
import { exportGpaArchive, restoreGpaArchive, validateGpaArchive } from '../src/lib/gpa-archive';
import { assertScratch, blockedBy, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

d('BO-13E GPA 역사 원장 archive guard와 복원', () => {
  let ds: DataSource;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('기존 행을 보존하고 일반 DML을 네 표 모두 막으며 restore와 down만 명시적으로 연다', async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const schema = `gpa_archive_${Date.now()}`;
    try {
      await q.query(`CREATE SCHEMA "${schema}"`);
      await q.query(`SET LOCAL search_path TO "${schema}"`);
      await q.query(`CREATE TABLE gpasvc (key varchar(8) PRIMARY KEY, name varchar(30) NOT NULL, point smallint NOT NULL, color char(7), sort smallint)`);
      await q.query(`CREATE TABLE gpa_cycle (id bigserial PRIMARY KEY, no smallint NOT NULL, from_date date NOT NULL, to_date date NOT NULL, closed boolean NOT NULL DEFAULT false, closed_at timestamptz, closed_by bigint)`);
      await q.query(`CREATE TABLE gpa_alloc (id bigserial PRIMARY KEY, cycle_id bigint NOT NULL, student_id bigint NOT NULL, coord_id bigint, points smallint NOT NULL)`);
      await q.query(`CREATE TABLE gpa_use (id bigserial PRIMARY KEY, cycle_id bigint NOT NULL, student_id bigint NOT NULL, ser_id bigint, svc_key varchar(8) NOT NULL, points smallint NOT NULL, on_date date NOT NULL, start_min smallint, coord_id bigint, note_url text, state varchar(8) NOT NULL, approved_by bigint, approved_at timestamptz)`);
      await q.query(`INSERT INTO gpasvc VALUES ('old','과거 규칙',2,'#112233',1)`);

      const migration = new GpaArchiveGuard1767300000000();
      await migration.up(q);
      expect(await q.query(`SELECT key FROM gpasvc`)).toEqual([{ key: 'old' }]);

      for (const sql of [
        `INSERT INTO gpasvc VALUES ('new','새 규칙',1,NULL,NULL)`,
        `INSERT INTO gpa_cycle (no,from_date,to_date) VALUES (1,'2026-01-01','2026-01-28')`,
        `INSERT INTO gpa_alloc (cycle_id,student_id,points) VALUES (1,1,1)`,
        `INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,state) VALUES (1,1,'old',2,'2026-01-02','ok')`,
        `UPDATE gpasvc SET point=3 WHERE key='old'`,
        `DELETE FROM gpasvc WHERE key='old'`,
        `TRUNCATE gpasvc`,
      ]) {
        expect(await blockedBy(q, sql)).toContain('GPA_RETIRED');
      }

      await q.query(`SET LOCAL taco.gpa_archive_restore = 'on'`);
      await q.query(`INSERT INTO gpa_cycle (id,no,from_date,to_date,closed,closed_at,closed_by) VALUES (11,3,'2026-01-01','2026-01-28',true,'2026-01-29T00:00:00Z',7)`);
      await q.query(`INSERT INTO gpa_alloc (id,cycle_id,student_id,coord_id,points) VALUES (21,11,8,7,10)`);
      await q.query(`INSERT INTO gpa_use (id,cycle_id,student_id,ser_id,svc_key,points,on_date,start_min,coord_id,note_url,state,approved_by,approved_at) VALUES (31,11,8,NULL,'old',2,'2026-01-02',600,7,'https://example.test/old','ok',9,'2026-01-03T00:00:00Z')`);
      const snapshot = await exportGpaArchive(q, new Date('2026-10-08T00:00:00Z'));
      expect(snapshot.rowCounts).toEqual({ gpasvc: 1, gpa_cycle: 1, gpa_alloc: 1, gpa_use: 1 });
      const portable = JSON.parse(JSON.stringify(snapshot)) as unknown;

      await q.query(`DELETE FROM gpa_use`);
      await q.query(`DELETE FROM gpa_alloc`);
      await q.query(`DELETE FROM gpa_cycle`);
      await q.query(`DELETE FROM gpasvc`);
      const restored = await restoreGpaArchive(q, portable);
      expect(restored.dataSha256).toBe(snapshot.dataSha256);
      expect(restored.tables).toEqual(snapshot.tables);

      const tampered = structuredClone(snapshot);
      tampered.tables.gpa_use[0].points = 99;
      expect(() => validateGpaArchive(tampered)).toThrow('GPA_ARCHIVE_HASH_MISMATCH');
      await expect(restoreGpaArchive(q, snapshot)).rejects.toThrow('GPA_ARCHIVE_TARGET_NOT_EMPTY');

      await migration.down(q);
      await q.query(`SET LOCAL taco.gpa_archive_restore = 'off'`);
      await expect(q.query(`UPDATE gpasvc SET point=3 WHERE key='old'`)).resolves.toBeDefined();
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
  });
});
