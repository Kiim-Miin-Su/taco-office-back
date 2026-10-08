/** @file-guide
 * 목적: BOC-06D-01 강사 불가시간의 10일·사유·실제 회차 충돌 DB 회귀.
 * 책임/재사용: TeacherService 공개 writer와 실제 PostgreSQL ser_occ.span을 사용해 경계와 readback을 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ConflictException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Ser } from '../src/entities';
import { addDays, todayKst } from '../src/lib/kst';
import { project } from '../src/modules/schedule/schedule.project';
import { loadState } from '../src/modules/schedule/schedule.state.repo';
import { TeacherService } from '../src/modules/teacher/teacher.service';
import { TeacherUnavailableConflictException } from '../src/modules/teacher/teacher-unavailable-conflict.error';
import { lockTeacherUnavailableWrite } from '../src/lib/teacher-unavailable';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

d('BOC-06D-01 — 강사 불가시간 계약', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let teacherId = 0;
  const today = todayKst();
  const openDate = addDays(today, 10);
  const KIND = `unav${process.pid}`.slice(0, 16);
  const svc = () => new TeacherService(q.manager.getRepository(Ser));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const [staff] = (await q.query(
      `INSERT INTO staff (name,role,email,active,tz,hired_on)
       VALUES ('불가시간 강사','teacher',$1,true,'Asia/Seoul',$2::date) RETURNING id`,
      [`unav-${process.pid}-${Date.now()}@qa.local`, addDays(today, -28)],
    )) as Array<{ id: string }>;
    teacherId = Number(staff.id);
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'불가시간 검증','#123456',4,'lesson',true)
       ON CONFLICT (key) DO NOTHING`,
      [KIND],
    );
  });
  afterEach(async () => { await q.rollbackTransaction(); await q.release(); });
  afterAll(async () => { await ds.destroy(); });

  it('오늘+10일부터 열고 trim 15자 사유를 저장·재조회한다', async () => {
    const before = await svc().unavailable(teacherId, openDate);
    expect(before.openFrom).toBe(openDate);

    await expect(svc().createUnavailable(teacherId, {
      onDate: addDays(today, 9), startMin: 480, endMin: 540, reason: '충분히 긴 불가시간 사유입니다',
    })).rejects.toMatchObject({ response: { code: 'UNAV_DEADLINE' } });

    await expect(svc().createUnavailable(teacherId, {
      onDate: openDate, startMin: 480, endMin: 540, reason: '  12345678901234  ',
    })).rejects.toMatchObject({ response: { code: 'UNAV_REASON_TOO_SHORT' } });

    const saved = await svc().createUnavailable(teacherId, {
      onDate: openDate, startMin: 480, endMin: 540, reason: '  123456789012345  ',
    });
    expect(saved).toMatchObject({ onDate: openDate, startMin: 480, endMin: 540, reason: '123456789012345', canDelete: true });
    expect((await svc().unavailable(teacherId, openDate)).blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: saved.id, reason: '123456789012345' }),
    ]));
  });

  it('옮긴 회차는 원래 onDate가 아니라 실제 span 날짜·시간으로 충돌시킨다', async () => {
    const ruleDate = addDays(openDate, -2);
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
       VALUES ($1,$2,'offline',600,660,'ONCE',$3::date,$3::date,'옮긴 실제 수업') RETURNING id`,
      [KIND, teacherId, ruleDate],
    )) as Array<{ id: string }>;
    await q.query(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,canceled,span)
       VALUES ($1,$2::date,$3,false,
         tstzrange(($4::date + time '10:00') AT TIME ZONE 'Asia/Seoul',
                   ($4::date + time '11:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [Number(ser.id), ruleDate, teacherId, openDate],
    );

    const attempt = svc().createUnavailable(teacherId, {
      onDate: openDate, startMin: 630, endMin: 690, reason: '실제 수업과 겹치는 충분한 사유',
    });
    await expect(attempt).rejects.toBeInstanceOf(TeacherUnavailableConflictException);
    await expect(attempt).rejects.toMatchObject({
      response: {
        code: 'UNAV_LESSON_CONFLICT', serId: Number(ser.id), onDate: ruleDate, actualDate: openDate,
        startMin: 600, endMin: 660, title: '옮긴 실제 수업',
      },
    });
  });

  it('취소 회차와 맞닿기만 한 회차는 막지 않고 기존 UNAV 겹침은 계속 막는다', async () => {
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
       VALUES ($1,$2,'offline',540,600,'ONCE',$3::date,$3::date,'취소 수업') RETURNING id`,
      [KIND, teacherId, openDate],
    )) as Array<{ id: string }>;
    await q.query(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,canceled,span)
       VALUES ($1,$2::date,$3,true,
         tstzrange(($2::date + time '09:00') AT TIME ZONE 'Asia/Seoul',
                   ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [Number(ser.id), openDate, teacherId],
    );

    await svc().createUnavailable(teacherId, {
      onDate: openDate, startMin: 600, endMin: 660, reason: '취소 회차 뒤라 등록 가능한 사유',
    });
    await expect(svc().createUnavailable(teacherId, {
      onDate: openDate, startMin: 630, endMin: 690, reason: '기존 불가시간과 겹치는 충분한 사유',
    })).rejects.toMatchObject({ response: { code: 'UNAV_OVERLAP' } });
  });

  it('서비스 직접 호출도 15자 검증을 우회하지 못한다', async () => {
    await expect(svc().createUnavailable(teacherId, {
      onDate: openDate, startMin: 480, endMin: 540, reason: '짧은 사유',
    })).rejects.toBeInstanceOf(ConflictException);
  });
});

d('BOC-06D-01 — 시간표 projection과 불가시간 동시 쓰기', () => {
  let ds: DataSource;
  let teacherId = 0;
  let serId = 0;
  const actualDate = addDays(todayKst(), 11);
  const KIND = `unavc${process.pid}`.slice(0, 16);

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    const [staff] = (await ds.query(
      `INSERT INTO staff (name,role,email,active,tz,hired_on)
       VALUES ('불가시간 동시성','teacher',$1,true,'Asia/Seoul',$2::date) RETURNING id`,
      [`unav-concurrency-${process.pid}@qa.local`, addDays(actualDate, -30)],
    )) as Array<{ id: string }>;
    teacherId = Number(staff.id);
    await ds.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'불가시간 동시성','#654321',4,'lesson',false)
       ON CONFLICT (key) DO NOTHING`,
      [KIND],
    );
    const [ser] = (await ds.query(
      `INSERT INTO ser (kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
       VALUES ($1,$2,'offline',600,660,'ONCE',$3::date,$3::date,'동시 편성 수업') RETURNING id`,
      [KIND, teacherId, actualDate],
    )) as Array<{ id: string }>;
    serId = Number(ser.id);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM ser WHERE id = $1`, [serId]);
    await ds.query(`DELETE FROM unav WHERE staff_id = $1`, [teacherId]);
    await ds.query(`DELETE FROM staff WHERE id = $1`, [teacherId]);
    await ds.query(`DELETE FROM kind WHERE key = $1`, [KIND]);
    await ds.destroy();
  });

  it('시간표가 잠금을 먼저 잡으면 등록은 커밋을 기다린 뒤 새 실제 회차를 보고 거절한다', async () => {
    const scheduleTx = ds.createQueryRunner();
    await scheduleTx.connect();
    await scheduleTx.startTransaction();
    try {
      await project(scheduleTx, await loadState(scheduleTx, [serId], { forWrite: true }), [serId], {
        from: actualDate, to: actualDate,
      });

      const pending = new TeacherService(ds.getRepository(Ser)).createUnavailable(teacherId, {
        onDate: actualDate, startMin: 630, endMin: 690, reason: '동시 편성 충돌을 확인하는 충분한 사유',
      });
      const stateBeforeCommit = await Promise.race([
        pending.then(() => 'resolved', () => 'rejected'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]);
      expect(stateBeforeCommit).toBe('waiting');

      await scheduleTx.commitTransaction();
      await expect(pending).rejects.toMatchObject({
        response: { code: 'UNAV_LESSON_CONFLICT', serId, actualDate },
      });
    } finally {
      if (scheduleTx.isTransactionActive) await scheduleTx.rollbackTransaction();
      await scheduleTx.release();
    }
  });

  it('불가시간이 잠금을 먼저 잡으면 편성은 커밋을 기다린 뒤 같은 원장을 보존하고 회차를 투영한다', async () => {
    const unavailableTx = ds.createQueryRunner();
    const scheduleTx = ds.createQueryRunner();
    await unavailableTx.connect();
    await scheduleTx.connect();
    await unavailableTx.startTransaction();
    await scheduleTx.startTransaction();
    try {
      await lockTeacherUnavailableWrite(unavailableTx, [teacherId]);
      const [block] = (await unavailableTx.query(
        `INSERT INTO unav (staff_id, on_date, dow, start_min, end_min, reason)
         VALUES ($1,$2::date,extract(dow from $2::date)::int,630,690,'동시 편성 경합을 확인하는 충분한 사유')
         RETURNING id`,
        [teacherId, actualDate],
      )) as Array<{ id: string }>;

      const pending = project(scheduleTx, await loadState(scheduleTx, [serId], { forWrite: true }), [serId], {
        from: actualDate, to: actualDate,
      });
      const stateBeforeCommit = await Promise.race([
        pending.then(() => 'resolved', () => 'rejected'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]);
      expect(stateBeforeCommit).toBe('waiting');

      await unavailableTx.commitTransaction();
      await expect(pending).resolves.toBe(1);
      await scheduleTx.commitTransaction();

      const [state] = (await ds.query(
        `SELECT
           (SELECT count(*)::int FROM unav WHERE id = $1) AS unavailable_count,
           (SELECT count(*)::int FROM ser_occ WHERE ser_id = $2 AND on_date = $3::date AND NOT canceled) AS lesson_count`,
        [Number(block.id), serId, actualDate],
      )) as Array<{ unavailable_count: number; lesson_count: number }>;
      expect(state).toEqual({ unavailable_count: 1, lesson_count: 1 });
    } finally {
      if (unavailableTx.isTransactionActive) await unavailableTx.rollbackTransaction();
      if (scheduleTx.isTransactionActive) await scheduleTx.rollbackTransaction();
      await unavailableTx.release();
      await scheduleTx.release();
    }
  });
});
