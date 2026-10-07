/** @file-guide
 * 목적: BO-Q13 권고안의 별도 agenda 정본·version·감사·잠금을 실제 PostgreSQL에서 검증한다.
 * 책임/재사용: 격리 *_test DB의 고유 schema만 사용하며 개발 DB·기존 fixture를 바꾸지 않는다.
 * 검증/작업 지침: docs/decisions/PLANNING-REQUIRED.md BO-Q13 · migration 1766100000000
 */

import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { MeetingAgenda1766100000000 } from '../src/migrations/1766100000000-meeting-agenda';
import { assertScratch, blockedBy, TEST_URL } from './db';
import { makeOpsService } from './ops-svc';

const url = assertScratch(TEST_URL);
jest.setTimeout(60_000);

describe('BO-Q13 agenda PostgreSQL 정본·동시성', () => {
  let admin: DataSource;
  let db: DataSource;
  let schema: string;

  const migration = new MeetingAgenda1766100000000();
  const service = () => makeOpsService(db.getRepository(Lead));

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    schema = `boq13_${randomUUID().replaceAll('-', '')}`;
    admin = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await admin.initialize();
    const q = admin.createQueryRunner();
    await q.connect();
    try {
      await q.query(`CREATE SCHEMA "${schema}"`);
      await q.query(`SET search_path TO "${schema}"`);
      await q.query(`CREATE TABLE staff (id bigint PRIMARY KEY, name text NOT NULL)`);
      await q.query(`CREATE TABLE room (id bigint PRIMARY KEY, name text NOT NULL)`);
      await q.query(`CREATE TABLE zacc (id bigint PRIMARY KEY, label text NOT NULL)`);
      await q.query(`CREATE TABLE ser (
        id bigint PRIMARY KEY, start_min integer NOT NULL, end_min integer NOT NULL,
        room_id bigint, mode text NOT NULL
      )`);
      await q.query(`CREATE TABLE exc (
        ser_id bigint NOT NULL, on_date date NOT NULL, new_date date,
        start_min integer, end_min integer, room_id bigint, zacc_id bigint, mode text
      )`);
      await q.query(`CREATE TABLE ser_occ (
        ser_id bigint NOT NULL, on_date date NOT NULL, span tstzrange NOT NULL,
        room_id bigint, zacc_id bigint, mode text
      )`);
      await q.query(`CREATE TABLE zassign (ser_id bigint NOT NULL, zacc_id bigint)`);
      await q.query(`CREATE TABLE mtrec (
        id bigint PRIMARY KEY, mt_type text NOT NULL, title text, on_date date,
        minutes text, ser_id bigint
      )`);
      await q.query(`CREATE TABLE log (
        id bigserial PRIMARY KEY, actor_id bigint, entity varchar(20), entity_id bigint,
        action varchar(20), before jsonb, after jsonb
      )`);
      await q.query(`INSERT INTO staff(id,name) VALUES (9101,'첫 관리자'),(9102,'둘째 관리자')`);
      await q.query(`INSERT INTO ser(id,start_min,end_min,mode) VALUES
        (41,600,660,'offline'),(42,600,660,'offline')`);
      await q.query(`INSERT INTO mtrec(id,mt_type,title,on_date,ser_id) VALUES
        (41,'general','미래 회의','2099-01-01',41),
        (42,'general','지난 회의','2020-01-01',42)`);
      await migration.up(q);
    } finally {
      await q.release();
    }

    db = new DataSource({
      ...dataSourceOptions,
      url,
      ssl: false,
      logging: false,
      extra: { ...(dataSourceOptions.extra as object), options: `-c search_path=${schema}` },
    });
    await db.initialize();
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('기존 회의를 보존한 채 별도 agenda version 1과 실제 actor 감사를 같은 트랜잭션에 만든다', async () => {
    const made = await service().writeMeetingAgenda(9101, 41, { content: '  첫 안건  ', expectedVersion: null });
    expect(made).toMatchObject({ meetingId: 41, content: '첫 안건', version: 1, createdById: 9101, updatedById: 9101 });
    const [row] = await db.query(`SELECT mt_id::int,content,version,created_by::int,updated_by::int FROM mtagenda WHERE mt_id=41`);
    expect(row).toEqual({ mt_id: 41, content: '첫 안건', version: 1, created_by: 9101, updated_by: 9101 });
    const [audit] = await db.query(`SELECT entity,action,before,after FROM log WHERE entity_id=41`);
    expect(audit).toMatchObject({ entity: 'MTAGENDA', action: 'write', before: null,
      after: { content: '첫 안건', version: 1 } });
    expect(await db.query(`SELECT title FROM mtrec WHERE id=41`)).toEqual([{ title: '미래 회의' }]);
  });

  it('같은 version의 동시 수정은 하나만 저장하고 다른 하나는 409로 최신 version을 돌려준다', async () => {
    const results = await Promise.allSettled([
      service().writeMeetingAgenda(9101, 41, { content: '동시 수정 A', expectedVersion: 1 }),
      service().writeMeetingAgenda(9102, 41, { content: '동시 수정 B', expectedVersion: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
    expect(rejected?.reason).toMatchObject({
      response: expect.objectContaining({ code: 'MEETING_AGENDA_VERSION_CONFLICT', expectedVersion: 1, actualVersion: 2 }),
    });
    const [row] = await db.query(`SELECT content,version,updated_by::int FROM mtagenda WHERE mt_id=41`);
    expect(row.version).toBe(2);
    expect(['동시 수정 A', '동시 수정 B']).toContain(row.content);
    expect(await db.query(`SELECT action FROM log WHERE entity_id=41 ORDER BY id`)).toHaveLength(2);
  });

  it('명시적 가져오기는 현재 version의 미저장 초안만 반환하고 minutes를 쓰지 않는다', async () => {
    await expect(service().importMeetingAgenda(41, { expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictException);
    const imported = await service().importMeetingAgenda(41, { expectedVersion: 2 });
    expect(imported).toMatchObject({ meetingId: 41, agendaVersion: 2, saved: false });
    expect(await db.query(`SELECT minutes FROM mtrec WHERE id=41`)).toEqual([{ minutes: null }]);
  });

  it('실제 시작이 지난 회의는 agenda와 감사 모두 만들지 않는다', async () => {
    await expect(service().writeMeetingAgenda(9101, 42, { content: '늦은 안건', expectedVersion: null }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'MEETING_AGENDA_LOCKED' }) });
    expect(await db.query(`SELECT 1 FROM mtagenda WHERE mt_id=42`)).toEqual([]);
    expect(await db.query(`SELECT 1 FROM log WHERE entity='MTAGENDA' AND entity_id=42`)).toEqual([]);
  });

  it('직접 SQL도 creator 불변·version 정확히 +1을 지키고 위반 뒤 정본은 그대로다', async () => {
    const q = db.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      expect(await blockedBy(q, `UPDATE mtagenda SET content='우회' WHERE mt_id=41`)).toMatch(/version must increase by exactly one/);
      expect(await blockedBy(q, `UPDATE mtagenda SET created_by=9102,version=3 WHERE mt_id=41`)).toMatch(/identity and creator are immutable/);
      await q.query(`UPDATE mtagenda SET content='정상 직접 수정',version=3,updated_by=9102,updated_at=now() WHERE mt_id=41`);
      expect(await q.query(`SELECT content,version,created_by::int,updated_by::int FROM mtagenda WHERE mt_id=41`))
        .toEqual([{ content: '정상 직접 수정', version: 3, created_by: 9101, updated_by: 9102 }]);
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
    expect(await db.query(`SELECT version FROM mtagenda WHERE mt_id=41`)).toEqual([{ version: 2 }]);
  });

  it('migration down은 agenda 표·trigger·함수만 제거하고 기존 회의는 보존한다', async () => {
    const q = db.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await migration.down(q);
      expect(await q.hasTable('mtagenda')).toBe(false);
      expect(await q.query(`SELECT title FROM mtrec WHERE id=41`)).toEqual([{ title: '미래 회의' }]);
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
  });
});
