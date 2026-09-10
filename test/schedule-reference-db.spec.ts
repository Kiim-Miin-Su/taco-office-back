/** @file-guide
 * 목적: schedule-reference-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { ScheduleReferenceContract1757700000000 } from '../src/migrations/1757700000000-schedule-reference-contract';
import { assertScratch, TEST_URL } from './db';

// DBML §79/80의 4표 12참조. migration 구현과 독립적으로 매핑을 검증한다.
const refs = [
  ['ser', 'kind_key', 'kind', 'key'], ['ser', 'sub_key', 'sub', 'key'],
  ['ser', 'teacher_id', 'staff', 'id'], ['ser', 'room_id', 'room', 'id'],
  ['ser_stu', 'ser_id', 'ser', 'id'], ['ser_stu', 'student_id', 'stu', 'id'],
  ['exc', 'ser_id', 'ser', 'id'], ['exc', 'teacher_id', 'staff', 'id'],
  ['exc', 'room_id', 'room', 'id'], ['exc', 'by_id', 'staff', 'id'],
  ['exc_stu_out', 'exc_id', 'exc', 'id'], ['exc_stu_out', 'student_id', 'stu', 'id'],
] as const;
const d = TEST_URL ? describe : describe.skip;

d('일정 DB 참조 계약 — 직접 쓰기도 방어한다', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const migration = new ScheduleReferenceContract1757700000000();
  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`INSERT INTO kind (key,name,color,cap,grp) VALUES ('fk_test','FK','#000000',1,'lesson')`);
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('fk_test','FK','#000000')`);
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (-770,'FK','fk-test@t.kr','ceo')`);
    await q.query(`INSERT INTO room (id,branch,name) VALUES (-770,'FK','FK')`);
    await q.query(`INSERT INTO stu (id,name) VALUES (-770,'FK')`);
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,room_id,mode,start_min,end_min,rrule,from_date)
      VALUES (-770,'fk_test','fk_test',-770,-770,'offline',600,660,'NONE','2026-09-11')`);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES (-770,-770)`);
    await q.query(`INSERT INTO exc (id,ser_id,on_date,teacher_id,room_id,by_id)
      VALUES (-770,-770,'2026-09-11',-770,-770,-770)`);
    await q.query(`INSERT INTO exc_stu_out (exc_id,student_id) VALUES (-770,-770)`);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it.each(refs)('%s.%s → %s.%s 없는 대상 쓰기를 차단한다', async (table, column, _parent, key) => {
    const where = table === 'ser_stu' ? 'ser_id=-770' : table === 'exc_stu_out' ? 'exc_id=-770' : 'id=-770';
    await expect(q.query(`UPDATE ${table} SET ${column}=$1 WHERE ${where}`, [key === 'key' ? 'missing_fk' : -771]))
      .rejects.toMatchObject({ code: '23503', constraint: `${table}_${column}_fk` });
  });

  it.each(['kind', 'sub', 'staff', 'room', 'stu', 'ser', 'exc'])('%s 참조 부모의 직접 삭제는 CASCADE 없이 차단한다', async (table) => {
    const where = ['kind', 'sub'].includes(table) ? "key='fk_test'" : 'id=-770';
    await expect(q.query(`DELETE FROM ${table} WHERE ${where}`)).rejects.toMatchObject({ code: '23503' });
  });

  it('down/up/reapply는 행을 보존하고 즉시 검증 FK 12개를 entity와 일치시킨다', async () => {
    const expected = refs.map(([table, column, parent, key]) => ({
      name: `${table}_${column}_fk`, table, column, parent, key,
    })).sort((a, b) => a.name.localeCompare(b.name));
    for (let round = 0; round < 2; round++) {
      await migration.down(q);
      expect(Object.values(await migration.preflight(q)).every((n) => n === 0)).toBe(true);
      await migration.up(q);
    }
    const actual = await q.query(`SELECT c.conname AS name, t.relname AS table, a.attname AS column,
      p.relname AS parent, b.attname AS key, c.convalidated, c.condeferrable, c.confdeltype, c.confupdtype
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class p ON p.oid=c.confrelid
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=c.conkey[1]
      JOIN pg_attribute b ON b.attrelid=p.oid AND b.attnum=c.confkey[1]
      WHERE c.conname=ANY($1) ORDER BY c.conname`, [expected.map((r) => r.name)]) as Record<string, unknown>[];
    expect(actual).toEqual(expected.map((r) => ({ ...r, convalidated: true, condeferrable: false, confdeltype: 'a', confupdtype: 'a' })));
    const metadata = ds.entityMetadatas.flatMap((m) => m.foreignKeys.map((fk) => ({
      name: fk.name, table: m.tableName, column: fk.columns[0].databaseName,
      parent: fk.referencedEntityMetadata.tableName, key: fk.referencedColumns[0].databaseName,
    }))).filter((r) => expected.some((e) => e.name === r.name)).sort((a, b) => a.name.localeCompare(b.name));
    expect(metadata).toEqual(expected);
    expect(await q.query(`SELECT * FROM exc_stu_out WHERE exc_id=-770 AND student_id=-770`)).toHaveLength(1);
  });

  it.each(refs)('%s.%s 고아 preflight는 자동 보정 없이 적용 전에 중단한다', async (table, column, _parent, key) => {
    await migration.down(q);
    const where = table === 'ser_stu' ? 'ser_id=-770' : table === 'exc_stu_out' ? 'exc_id=-770' : 'id=-770';
    const missing = key === 'key' ? 'missing_fk' : -771;
    await q.query(`UPDATE ${table} SET ${column}=$1 WHERE ${where}`, [missing]);
    expect(await migration.preflight(q)).toMatchObject({ [`${table}_${column}_fk`]: 1 });
    await expect(migration.up(q)).rejects.toThrow('Schedule reference preflight failed');
    expect(await q.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [missing])).toHaveLength(1);
    expect(await q.query(`SELECT 1 FROM pg_constraint WHERE conname='ser_kind_key_fk'`)).toHaveLength(0);
  });

  it('nullable 자원과 이력 보존용 종료일 역전은 참조 제약으로 금지하지 않는다', async () => {
    await q.query(`UPDATE ser SET sub_key=NULL,teacher_id=NULL,room_id=NULL,to_date='2026-09-10' WHERE id=-770`);
    await q.query(`UPDATE exc SET teacher_id=NULL,room_id=NULL,by_id=NULL WHERE id=-770`);
    expect(Object.values(await migration.preflight(q)).every((n) => n === 0)).toBe(true);
  });
});
