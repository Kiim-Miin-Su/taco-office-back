/** @file-guide
 * 목적: §44 학생별·§45 이력/누락/초안과 GUIDE DB 논리 키를 실제 Postgres에서 검증한다.
 * 책임/재사용: GuidesService 공개 메서드와 migration 제약을 사용하며 테스트 규칙을 별도 구현하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { todayKst } from '../src/lib/kst';
import { GuidesService } from '../src/modules/guides/guides.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

d('§44·§45 안내 수직 계약 (C78)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let studentId: number;
  let firstOccurrenceId: number;
  let middleOccurrenceId: number;
  let changedOccurrenceId: number;
  const manager = 1781;
  const teacherA = 1782;
  const teacherB = 1783;
  const serId = -1781;
  const kindKey = 'c78-guide';
  const svc = () => new GuidesService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES
      ($1,'안내 관리자','guide-manager-c78@test','manager'),
      ($2,'첫 강사','guide-teacher-a-c78@test','teacher'),
      ($3,'교체 강사','guide-teacher-b-c78@test','teacher')
      ON CONFLICT (id) DO NOTHING`, [manager, teacherA, teacherB]);
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'안내 테스트','#123456',8,'lesson',true)
      ON CONFLICT (key) DO NOTHING`, [kindKey]);
    const [student] = await q.query(`INSERT INTO stu (name,grade,guidance,lang) VALUES ('안내 학생 C78','G7','엄격 + 관리','ko') RETURNING id`);
    studentId = Number(student.id);
    await q.query(`INSERT INTO ser (id,kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
      VALUES ($1,$2,$3,'offline',600,660,'FREQ=WEEKLY;BYDAY=TU','2026-09-01','2026-09-30','C78 안내 수업')`,
    [serId, kindKey, teacherA]);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serId, studentId]);
    const occurrences = await q.query(`INSERT INTO ser_occ (ser_id,on_date,teacher_id,span) VALUES
      ($1,'2026-09-01',$2,'[2026-09-01 10:00+09,2026-09-01 11:00+09)'),
      ($1,'2026-09-08',$2,'[2026-09-08 10:00+09,2026-09-08 11:00+09)'),
      ($1,'2026-09-15',$3,'[2026-09-15 10:00+09,2026-09-15 11:00+09)')
      RETURNING id,on_date`, [serId, teacherA, teacherB]);
    firstOccurrenceId = Number(occurrences[0].id);
    middleOccurrenceId = Number(occurrences[1].id);
    changedOccurrenceId = Number(occurrences[2].id);
  });
  afterEach(async () => { if (q?.isTransactionActive) await q.rollbackTransaction(); if (q && !q.isReleased) await q.release(); });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('월 이력은 첫 수업·강사 교체만 누락으로 계산하고 같은 클릭은 한 초안으로 수렴한다', async () => {
    const before = await svc().history({ span: 'month', anchor: '2026-09-14' });
    expect(before.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceOccurrenceId: firstOccurrenceId, reason: 'new', studentId }),
      expect.objectContaining({ sourceOccurrenceId: changedOccurrenceId, reason: 'teacher_change', studentId }),
    ]));
    expect(before.missing).toHaveLength(2);

    const made = await svc().createDraft(manager, { sourceOccurrenceId: firstOccurrenceId, studentId });
    const repeated = await svc().createDraft(manager, { sourceOccurrenceId: firstOccurrenceId, studentId });
    expect(repeated.id).toBe(made.id);
    expect(made).toMatchObject({ reason: 'new', eventOn: '2026-09-01', sourceOccurrenceId: firstOccurrenceId, state: 'draft' });
    expect(Number((await q.query(
      `SELECT count(*)::int AS n FROM guide WHERE ser_id=$1 AND event_on='2026-09-01' AND student_id=$2 AND reason='new'`,
      [serId, studentId],
    ))[0].n)).toBe(1);

    const after = await svc().history({ span: 'month', anchor: '2026-09-14' });
    expect(after.counts).toMatchObject({ created: 1, missing: 1 });
    expect(after.days[0].items[0].id).toBe(made.id);
  });

  it('일·주·월 이력 범위는 KST 기준일에서 같은 누락 계산식을 공유한다', async () => {
    const day = await svc().history({ span: 'day', anchor: '2026-09-08' });
    expect(day).toMatchObject({ from: '2026-09-08', to: '2026-09-08', counts: { missing: 0 } });

    const week = await svc().history({ span: 'week', anchor: '2026-09-16' });
    expect(week).toMatchObject({ from: '2026-09-14', to: '2026-09-20', counts: { missing: 1 } });
    expect(week.missing[0]).toMatchObject({ sourceOccurrenceId: changedOccurrenceId, reason: 'teacher_change' });

    const month = await svc().history({ span: 'month', anchor: '2026-09-30' });
    expect(month).toMatchObject({ from: '2026-09-01', to: '2026-09-30', counts: { missing: 2 } });
  });

  it('S4-a 생성/작성/재생성/목록/학생별/이력은같은viewer판정을쓰고미제공은닫힌다', async () => {
    const viewer = { id: manager, name: '안내 관리자', role: 'manager' };
    const dto = { sourceOccurrenceId: firstOccurrenceId, studentId };
    const made = await svc().createDraft(manager, dto, viewer);
    expect(made).toMatchObject({ canSend: false, canAck: false, sendBlockedReason: expect.any(String), acknowledgedAfterSeconds: null });
    const ready = await svc().writeBody(manager, made.id, { body: '수신 강사가 확인할 본문' }, viewer);
    const expected = { canSend: true, canAck: false, sendBlockedReason: null, acknowledgedAfterSeconds: null };
    expect(ready).toMatchObject(expected);
    expect(await svc().createDraft(manager, dto, viewer)).toMatchObject(expected);
    expect((await svc().all(undefined, viewer)).guides.find(g => g.id === made.id)).toMatchObject(expected);
    expect((await svc().students(viewer)).items.find(s => s.studentId === studentId)?.latestGuide).toMatchObject(expected);
    expect((await svc().history({ span: 'day', anchor: '2026-09-01' }, viewer)).days[0].items[0]).toMatchObject(expected);
    expect((await svc().all()).guides.find(g => g.id === made.id)).toMatchObject({ canSend: false, canAck: false, sendBlockedReason: expect.any(String) });
  });

  it('중간의 같은 강사 회차와 명단 밖 학생은 초안 생성에서 다시 거절한다', async () => {
    await expect(svc().createDraft(manager, { sourceOccurrenceId: middleOccurrenceId, studentId }))
      .rejects.toMatchObject({ response: { code: 'GUIDE_CANDIDATE_STALE' } });
    const [outsider] = await q.query(`INSERT INTO stu (name) VALUES ('명단 밖 C78') RETURNING id`);
    await expect(svc().createDraft(manager, { sourceOccurrenceId: firstOccurrenceId, studentId: Number(outsider.id) }))
      .rejects.toMatchObject({ response: { code: 'GUIDE_CANDIDATE_STALE' } });
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM guide WHERE ser_id=$1`, [serId]))[0].n)).toBe(0);
  });

  it('학생별은 최신 안내와 학생/진단을 한 학생 projection으로 돌려준다', async () => {
    const first = await svc().createDraft(manager, { sourceOccurrenceId: firstOccurrenceId, studentId });
    await svc().writeBody(manager, first.id, { body: '첫 수업 안내 본문' });
    await q.query(`INSERT INTO diag (student_id,ser_id,level_summary,strengths,created_by)
      VALUES ($1,$2,'G7 진단','문법',$3)`, [studentId, serId, teacherA]);
    const changed = await svc().createDraft(manager, { sourceOccurrenceId: changedOccurrenceId, studentId });
    const projection = await svc().students();
    const item = projection.items.find((row) => row.studentId === studentId);
    expect(item).toMatchObject({
      studentName: '안내 학생 C78', grade: 'G7', guidance: '엄격 + 관리', lang: 'ko', guideCount: 2,
      latestGuide: { id: changed.id, reason: 'teacher_change' },
      diagnostic: { levelSummary: 'G7 진단', strengths: '문법' },
    });
  });

  it('§43 매번은 PNOTI가 없어도 오늘 온라인 회차·명단·줌 배정을 먼저 보여 준다', async () => {
    const date = todayKst();
    const onlineSerId = serId - 1;
    const zaccId = -1781;
    const [second] = await q.query(`INSERT INTO stu (name) VALUES ('온라인 둘째 C78') RETURNING id`);
    await q.query(`INSERT INTO zacc (id,label,login_email,login_secret,join_url,active)
      VALUES ($1,'C78 Zoom','zoom-c78@test',decode('00','hex'),'https://example.test/c78',true)`, [zaccId]);
    await q.query(`INSERT INTO ser (id,kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
      VALUES ($1,$2,$3,'online',600,660,'FREQ=DAILY',$4,$4,'C78 온라인 수업')`,
    [onlineSerId, kindKey, teacherA, date]);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2),($1,$3)`, [onlineSerId, studentId, Number(second.id)]);
    const [occurrence] = await q.query(`INSERT INTO ser_occ (ser_id,on_date,teacher_id,zacc_id,span)
      VALUES ($1,$2,$3,$4,tstzrange(($2::date+interval '10 hours') AT TIME ZONE 'Asia/Seoul',
                                      ($2::date+interval '11 hours') AT TIME ZONE 'Asia/Seoul','[)')) RETURNING id`,
    [onlineSerId, date, teacherA, zaccId]);
    await q.query(`INSERT INTO pnoti (ser_id,on_date,student_id,channel,body,sent_at)
      VALUES ($1,$2,$3,'app','줌 링크 안내',now())`, [onlineSerId, date, studentId]);
    await q.query(`INSERT INTO pnoti (ser_id,on_date,student_id,channel,body,sent_at)
      VALUES ($1,$2,$3,'kakao','최신 줌 링크 안내',now())`, [onlineSerId, date, studentId]);

    const out = await svc().all();
    const notice = out.perLesson.find((row) => row.sourceOccurrenceId === Number(occurrence.id));
    expect(notice).toMatchObject({
      serId: onlineSerId, onDate: date, startMin: 600, endMin: 660,
      teacherId: teacherA, zaccId, zaccLabel: 'C78 Zoom', zoomAssigned: true,
      parentDeliveryRecorded: false, teacherDeliveryRecorded: false,
    });
    expect(notice?.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId, channel: 'kakao', body: '최신 줌 링크 안내', sentAt: expect.any(String) }),
      expect.objectContaining({ studentId: Number(second.id), body: null, sentAt: null }),
    ]));
    expect(notice?.notices).toHaveLength(2);
    expect(out.deliveryCapabilities).toMatchObject({ parentExternal: false, teacherExternal: false });
  });

  it('DB는 회차와 다른 담당 강사 또는 중복 논리 이벤트를 직접 넣어도 막는다', async () => {
    await q.query('SAVEPOINT wrong_teacher');
    await expect(q.query(`INSERT INTO guide (ser_id,event_on,student_id,teacher_id,reason,due_on)
      VALUES ($1,'2026-09-01',$2,$3,'new','2026-09-01')`, [serId, studentId, teacherB]))
      .rejects.toMatchObject({ constraint: 'guide_event_source_valid' });
    await q.query('ROLLBACK TO SAVEPOINT wrong_teacher');
    await svc().createDraft(manager, { sourceOccurrenceId: firstOccurrenceId, studentId });
    await q.query('SAVEPOINT duplicate_event');
    await expect(q.query(`INSERT INTO guide (ser_id,event_on,student_id,teacher_id,reason,due_on)
      VALUES ($1,'2026-09-01',$2,$3,'new','2026-09-01')`, [serId, studentId, teacherA]))
      .rejects.toMatchObject({ constraint: 'guide_event_unique' });
    await q.query('ROLLBACK TO SAVEPOINT duplicate_event');
  });
});
