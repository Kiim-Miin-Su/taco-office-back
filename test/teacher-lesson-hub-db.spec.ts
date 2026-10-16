/** @file-guide
 * 목적: teacher-lesson-hub-db.spec.ts — BOC-05D-01 exact teacher lesson hub DB regression
 * 책임/재사용: 실제 PostgreSQL에서 본인 범위·이동 날짜·안내/학생 이력 projection을 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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

d('BOC-05D-01 — 강사 수업 허브 exact read contract', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let teacherId = 0;
  let otherTeacherId = 0;
  let studentId = 0;
  const today = todayKst();
  const KIND = `hub${process.pid}`.slice(0, 16);
  const svc = () => new TeacherService(q.manager.getRepository(Ser));

  async function lesson(ownerId: number, ruleDate: string, actualDate = ruleDate, title = '허브 수업'): Promise<number> {
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
       VALUES ($1,$2,'offline',600,660,'ONCE',$3::date,$3::date,$4) RETURNING id`,
      [KIND, ownerId, ruleDate, title],
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
      await q.query(
        `INSERT INTO exc (ser_id,on_date,new_date,by_id) VALUES ($1,$2::date,$3::date,$4)`,
        [serId, ruleDate, actualDate, ownerId],
      );
    }
    return serId;
  }

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const staff = (await q.query(
      `INSERT INTO staff (name,role,email,active,tz) VALUES
       ('허브 강사','teacher',$1,true,'Asia/Seoul'),
       ('다른 강사','teacher',$2,true,'Asia/Seoul') RETURNING id,name`,
      [`hub-${process.pid}@qa.local`, `hub-other-${process.pid}@qa.local`],
    )) as Array<{ id: string; name: string }>;
    teacherId = Number(staff.find((item) => item.name === '허브 강사')?.id);
    otherTeacherId = Number(staff.find((item) => item.name === '다른 강사')?.id);
    const [student] = (await q.query(
      `INSERT INTO stu (name,grade,school,guidance,lang) VALUES ('허브 학생','중2','검증중','꼼꼼하게','ko') RETURNING id`,
    )) as Array<{ id: string }>;
    studentId = Number(student.id);
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'허브 수업','#123456',4,'lesson',true)
       ON CONFLICT (key) DO NOTHING`,
      [KIND],
    );
  });
  afterEach(async () => { await q.rollbackTransaction(); await q.release(); });
  afterAll(async () => { await ds.destroy(); });

  it('본인 exact 회차는 구조화 안내와 같은 학생의 본인 수업 이력만 반환한다', async () => {
    const exactDate = addDays(today, -1);
    const exact = await lesson(teacherId, exactDate, exactDate, '선택 수업');
    const older = await lesson(teacherId, addDays(today, -8), addDays(today, -8), '지난 수업');
    const foreign = await lesson(otherTeacherId, addDays(today, -3), addDays(today, -3), '다른 강사 수업');
    // B1014-04: 최신 학생 프로필(지도 방향·언어)은 끝나지 않은 회차가 남은 현재 담당자에게만 열린다.
    // 지난 회차만 있는 대역은 그 규칙에 막히므로 다음 주 수업을 하나 둬 계속 맡는 강사로 만든다(S5a 2026-10-16 — 제품 판정은 그대로).
    await lesson(teacherId, addDays(today, 7), addDays(today, 7), '다음 수업');

    const result = await svc().lessonHub(teacherId, exact, exactDate, exactDate);

    expect(result.lesson).toMatchObject({ serId: exact, onDate: exactDate, date: exactDate, repState: 'none' });
    expect(result.guideStudents).toHaveLength(1);
    expect(result.guideStudents[0]).toMatchObject({ studentId, name: '허브 학생', guidance: '꼼꼼하게', lang: 'ko' });
    expect(result.history.map((item) => item.serId)).toEqual(expect.arrayContaining([exact, older]));
    expect(result.history.map((item) => item.serId)).not.toContain(foreign);
    expect(result.history.every((item) => item.studentItems.some((student) => student.id === studentId))).toBe(true);
    expect(result.capabilities).toMatchObject({
      report: { enabled: true }, guide: { enabled: true }, history: { enabled: true }, scheduleChange: { enabled: true },
    });
    expect(result.history[0]).not.toHaveProperty('pay');
    expect(result.history[0]).not.toHaveProperty('privateNote');
  });

  it('이동된 회차의 stale 실제 날짜는 409와 최신 actualDate를 반환한다', async () => {
    const ruleDate = addDays(today, 2);
    const actualDate = addDays(today, 4);
    const id = await lesson(teacherId, ruleDate, actualDate);
    await expect(svc().lessonHub(teacherId, id, ruleDate, ruleDate)).rejects.toMatchObject({
      response: { code: 'TEACHER_LESSON_MOVED', actualDate },
    });
    await expect(svc().lessonHub(teacherId, id, ruleDate, actualDate)).resolves.toMatchObject({
      lesson: { serId: id, onDate: ruleDate, date: actualDate },
    });
  });

  it('hard reload read model은 이 강사의 pending 일정 변경 요청과 승인 전 원래 일정을 함께 돌려준다', async () => {
    const date = addDays(today, 12);
    const id = await lesson(teacherId, date, date, '승인 대기 수업');
    const [request] = (await q.query(
      `INSERT INTO chreq (ser_id,on_date,req_type,payload,reason,by_id,source_date,read_version)
       VALUES ($1,$2::date,'time_move',$3::jsonb,'학생과 확인한 변경 요청',$4,$2::date,0) RETURNING id`,
      [id, date, JSON.stringify({ requestedDate: addDays(date, 1), startMin: 720, endMin: 780 }), teacherId],
    )) as Array<{ id: string }>;

    const result = await svc().lessonHub(teacherId, id, date, date);

    expect(result.lesson).toMatchObject({ serId: id, date, startMin: 600 });
    expect(result.scheduleChangeRequest).toMatchObject({
      id: Number(request.id), state: 'pending', asked: `${addDays(date, 1)} 12:00–13:00 로 이동`,
    });
    expect(result.capabilities.scheduleChange).toEqual({
      enabled: false, reason: '이 수업의 일정 변경 요청이 관리자 승인 대기 중입니다.',
    });
  });

  it('다른 강사 회차와 존재하지 않는 회차는 같은 숨김형 404다', async () => {
    const date = addDays(today, -1);
    const foreign = await lesson(otherTeacherId, date);
    for (const id of [foreign, Number.MAX_SAFE_INTEGER]) {
      await expect(svc().lessonHub(teacherId, id, date, date)).rejects.toMatchObject({
        response: { code: 'TEACHER_LESSON_NOT_FOUND', message: '담당 수업을 찾을 수 없습니다.' },
      });
    }
  });
});
