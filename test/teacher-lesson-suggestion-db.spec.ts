/** @file-guide
 * 목적: BO-06D-03 수업 팝업 건의의 exact identity·스냅숏·멱등·stale 판정을 실제 PostgreSQL에서 검증한다.
 * 책임/재사용: TeacherService의 기존 월 3회 writer를 호출하고 전용 fixture는 바깥 transaction rollback으로 정리한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-06-SCENARIOS-2026-10-07.md · docs/AGENT.md
 */

import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Ser } from '../src/entities';
import { addDays, todayKst } from '../src/lib/kst';
import { TeacherService } from '../src/modules/teacher/teacher.service';
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

d('BO-06D-03 — 10일 미만·지난 수업 exact 건의 writer', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let teacherId = 0;
  let otherTeacherId = 0;
  let studentId = 0;
  const today = todayKst();
  const KIND = `sg${process.pid}`.slice(0, 16);
  const svc = () => new TeacherService(q.manager.getRepository(Ser));

  async function lesson(ownerId: number, ruleDate: string, actualDate = ruleDate): Promise<number> {
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
       VALUES ($1,$2,'offline',600,660,'ONCE',$3::date,$3::date,'Exact 건의 수업') RETURNING id`,
      [KIND, ownerId, ruleDate],
    )) as Array<{ id: string }>;
    const serId = Number(ser.id);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serId, studentId]);
    await q.query(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,canceled,span)
       VALUES ($1,$2::date,$3,false,
         tstzrange(($4::date + time '10:00') AT TIME ZONE 'Asia/Seoul',
                   ($4::date + time '11:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [serId, ruleDate, ownerId, actualDate],
    );
    if (ruleDate !== actualDate) {
      await q.query(`INSERT INTO exc (ser_id,on_date,new_date,by_id) VALUES ($1,$2::date,$3::date,$4)`,
        [serId, ruleDate, actualDate, ownerId]);
    }
    return serId;
  }

  const version = async (): Promise<number> => Number((await q.query(`SELECT COALESCE(max(id),0) AS v FROM log`))[0].v);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const staff = (await q.query(
      `INSERT INTO staff (name,role,email,active,tz) VALUES
       ('건의 강사','teacher',$1,true,'Asia/Seoul'),
       ('다른 건의 강사','teacher',$2,true,'Asia/Seoul') RETURNING id,name`,
      [`suggestion-${process.pid}-${randomUUID()}@qa.local`, `suggestion-other-${process.pid}-${randomUUID()}@qa.local`],
    )) as Array<{ id: string; name: string }>;
    teacherId = Number(staff.find((item) => item.name === '건의 강사')?.id);
    otherTeacherId = Number(staff.find((item) => item.name === '다른 건의 강사')?.id);
    const [student] = (await q.query(`INSERT INTO stu (name) VALUES ('건의 학생') RETURNING id`)) as Array<{ id: string }>;
    studentId = Number(student.id);
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'SAT Math','#123456',4,'lesson',true)
       ON CONFLICT (key) DO NOTHING`, [KIND],
    );
  });
  afterEach(async () => { await q.rollbackTransaction(); await q.release(); });
  afterAll(async () => { await ds.destroy(); });

  it('지난 수업을 한 번 저장하고 같은 requestKey 재전송은 같은 receipt·쿼터 1회로 수렴한다', async () => {
    const date = addDays(today, -1);
    const serId = await lesson(teacherId, date);
    const requestKey = randomUUID();
    const body = {
      category: 'schedule', body: '지난 수업의 시간을 확인해 주세요', requestKey,
      lesson: { serId, onDate: date, sourceDate: date, readVersion: await version() },
    };

    const first = await svc().createSuggestion(teacherId, body);
    const retry = await svc().createSuggestion(teacherId, body);
    expect(retry.id).toBe(first.id);
    expect(first.lesson).toEqual({
      serId, onDate: date, date, startMin: 600, endMin: 660,
      subject: 'SAT Math', title: 'Exact 건의 수업', students: ['건의 학생'],
    });
    expect((await svc().suggestions(teacherId)).used).toBe(1);
    expect(await q.query(
      `SELECT ser_id,to_char(on_date,'YYYY-MM-DD') AS on_date,
              to_char(source_date,'YYYY-MM-DD') AS source_date,lesson_snapshot,request_key::text
         FROM suggestion WHERE id=$1`, [first.id],
    )).toEqual([expect.objectContaining({
      ser_id: String(serId), on_date: date, source_date: date,
      lesson_snapshot: first.lesson, request_key: requestKey,
    })]);
  });

  it('다른 본문에 같은 키, 다른 강사 회차, stale 날짜/version, 정확히 10일 이상은 쓰기 없이 거절한다', async () => {
    const date = addDays(today, -1);
    const serId = await lesson(teacherId, date);
    const foreign = await lesson(otherTeacherId, date);
    const requestKey = randomUUID();
    const readVersion = await version();
    const exact = { serId, onDate: date, sourceDate: date, readVersion };
    await svc().createSuggestion(teacherId, { category: 'schedule', body: '같은 키 기준 본문', requestKey, lesson: exact });
    await expect(svc().createSuggestion(teacherId, {
      category: 'schedule', body: '다른 본문', requestKey, lesson: exact,
    })).rejects.toMatchObject({ response: { code: 'SUGGESTION_REQUEST_KEY_REUSED' } });
    await expect(svc().createSuggestion(teacherId, {
      category: 'schedule', body: '남의 회차', requestKey: randomUUID(),
      lesson: { serId: foreign, onDate: date, sourceDate: date, readVersion },
    })).rejects.toMatchObject({ response: { code: 'SUGGESTION_LESSON_NOT_FOUND' } });

    const movedOn = addDays(today, -4);
    const movedTo = addDays(today, -3);
    const moved = await lesson(teacherId, movedOn, movedTo);
    await expect(svc().createSuggestion(teacherId, {
      category: 'schedule', body: '옮긴 회차 stale 날짜', requestKey: randomUUID(),
      lesson: { serId: moved, onDate: movedOn, sourceDate: movedOn, readVersion: await version() },
    })).rejects.toMatchObject({ response: { code: 'SUGGESTION_LESSON_STALE', currentDate: movedTo } });

    const staleVersion = await version();
    await q.query(`INSERT INTO log (actor_id,entity,entity_id,action) VALUES ($1,'SER',$2,'patch')`, [teacherId, serId]);
    await expect(svc().createSuggestion(teacherId, {
      category: 'schedule', body: '읽은 뒤 바뀐 회차', requestKey: randomUUID(),
      lesson: { serId, onDate: date, sourceDate: date, readVersion: staleVersion },
    })).rejects.toMatchObject({ response: { code: 'SUGGESTION_LESSON_STALE' } });

    const future = addDays(today, 10);
    const futureId = await lesson(teacherId, future);
    await expect(svc().createSuggestion(teacherId, {
      category: 'schedule', body: '열흘 뒤는 변경 요청', requestKey: randomUUID(),
      lesson: { serId: futureId, onDate: future, sourceDate: future, readVersion: await version() },
    })).rejects.toMatchObject({ response: { code: 'SUGGESTION_CHANGE_REQUEST_REQUIRED', remainingDays: 10 } });
    expect((await svc().suggestions(teacherId)).used).toBe(1);
  });

  it('DB는 부분 회차 링크와 음수 version 직접 쓰기를 막고 기존 일반 건의는 보존한다', async () => {
    const rejected = async (name: string, sql: string): Promise<Record<string, unknown>> => {
      await q.query(`SAVEPOINT ${name}`);
      try {
        await q.query(sql, [teacherId]);
        throw new Error('제약 위반이 발생하지 않았습니다');
      } catch (error) {
        await q.query(`ROLLBACK TO SAVEPOINT ${name}`);
        return error as Record<string, unknown>;
      }
    };
    expect(await rejected('partial_link',
      `INSERT INTO suggestion (staff_id,category,body,ser_id) VALUES ($1,'schedule','부분 링크',1)`))
      .toMatchObject({ code: '23514', constraint: 'suggestion_lesson_link_contract' });
    expect(await rejected('missing_snapshot_receipt',
      `INSERT INTO suggestion (staff_id,category,body,ser_id,on_date,source_date,read_version)
       VALUES ($1,'schedule','스냅숏·멱등키 누락',1,current_date,current_date,0)`))
      .toMatchObject({ code: '23514', constraint: 'suggestion_lesson_link_contract' });
    expect(await rejected('negative_version',
      `INSERT INTO suggestion (staff_id,category,body,read_version) VALUES ($1,'schedule','음수 버전',-1)`))
      .toMatchObject({ code: '23514' });
    await expect(q.query(
      `INSERT INTO suggestion (staff_id,category,body) VALUES ($1,'etc','기존 일반 건의') RETURNING id`, [teacherId],
    )).resolves.toHaveLength(1);
  });
});
