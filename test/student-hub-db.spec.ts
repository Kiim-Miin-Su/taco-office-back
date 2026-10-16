/** @file-guide
 * 목적: student-hub-db.spec.ts — BOC-04D-01 학생 aggregate의 exact FK/cursor/금액 projection 실제 PostgreSQL 회귀
 * 책임/재사용: 격리 TEST_URL에 이 시험이 만든 행만 추가·정리하고 StudentsService의 생성 DTO 계약을 그대로 호출한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource } from 'typeorm';
import { StudentsService } from '../src/modules/students/students.service';
import { assertScratch, DEV_URL, TEST_URL } from './db';

const URL = DEV_URL ? assertScratch(TEST_URL) : undefined;
const suite = URL ? describe : describe.skip;

suite('BOC-04D-01 학생 허브 실제 DB', () => {
  let ds: DataSource;
  let service: StudentsService;
  let studentId = 0;
  let otherStudentId = 0;
  let serId = 0;
  let reportId = 0;
  let staffId = 0;
  const kindKey = 'boc04_hub';

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: URL, synchronize: false, logging: false });
    await ds.initialize();
    service = new StudentsService(ds);
    const [staff] = await ds.query(`INSERT INTO staff(name,email,role,active) VALUES ('BOC04 허브 담당','boc04-hub@test.local','manager',true) RETURNING id`) as Array<{ id: string }>;
    staffId = Number(staff.id);
    await ds.query(`INSERT INTO kind(key,name,color,cap,grp,rep) VALUES ($1,'BOC04 허브 수업','#335577',4,'lesson',true)`, [kindKey]);
    [studentId, otherStudentId] = (await ds.query(`INSERT INTO stu(name) VALUES ('BOC04 허브 A'),('BOC04 허브 B') RETURNING id`) as Array<{ id: string }>).map(row => Number(row.id));
    const [ser] = await ds.query(`INSERT INTO ser(kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
      VALUES ($1,$2,'online',600,660,'WEEKLY:WE','2026-10-01','2026-10-31','BOC04 cursor') RETURNING id`, [kindKey, staffId]) as Array<{ id: string }>;
    serId = Number(ser.id);
    await ds.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES ($1,$2)`, [serId, studentId]);
    await ds.query(`INSERT INTO ser_occ(ser_id,on_date,teacher_id,span)
      SELECT $1,day,$2,tstzrange((day + time '10:00') AT TIME ZONE 'Asia/Seoul',
        (day + time '11:00') AT TIME ZONE 'Asia/Seoul','[)')
      FROM (SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date + 7) AS day) future`, [serId, staffId]);
    const [report] = await ds.query(`INSERT INTO rep(ser_id,on_date,teacher_id,kind_key,body,state,written_at,submitted_at)
      VALUES ($1,'2026-10-07',$2,$3,'{"content":"본문","progress":"진도","homework":"숙제"}'::jsonb,'wait',now(),now()) RETURNING id`, [serId, staffId, kindKey]) as Array<{ id: string }>;
    reportId = Number(report.id);
    await ds.query(`INSERT INTO rep_stu(rep_id,student_id,deliver) VALUES ($1,$2,true)`, [reportId, studentId]);
    await ds.query(`INSERT INTO note(student_id,author_id,body,created_at)
      SELECT $1,$2,'BOC04 note '||g,clock_timestamp()-(g||' microseconds')::interval FROM generate_series(1,51) g`, [studentId, staffId]);
    await ds.query(`INSERT INTO inv(student_id,year_month,inv_type,title,amount,state,paid_amount,due_on)
      VALUES ($1,'2026-10','tuition','BOC04 10월',100000,'partial',30000,'2026-10-10'),
             ($1,'2026-09','tuition','BOC04 9월',90000,'paid',90000,'2026-09-10')`, [studentId]);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DELETE FROM note WHERE student_id=ANY($1::bigint[])`, [[studentId, otherStudentId]]);
      await ds.query(`DELETE FROM inv WHERE student_id=ANY($1::bigint[])`, [[studentId, otherStudentId]]);
      if (reportId) await ds.query(`DELETE FROM rep_stu WHERE rep_id=$1`, [reportId]);
      if (reportId) await ds.query(`DELETE FROM rep WHERE id=$1`, [reportId]);
      if (serId) await ds.query(`DELETE FROM ser_occ WHERE ser_id=$1`, [serId]);
      if (serId) await ds.query(`DELETE FROM ser_stu WHERE ser_id=$1`, [serId]);
      if (serId) await ds.query(`DELETE FROM ser WHERE id=$1`, [serId]);
      if (studentId && otherStudentId) await ds.query(`DELETE FROM stu WHERE id=ANY($1::bigint[])`, [[studentId, otherStudentId]]);
      await ds.query(`DELETE FROM kind WHERE key=$1`, [kindKey]);
      if (staffId) await ds.query(`DELETE FROM staff WHERE id=$1`, [staffId]);
      await ds.destroy();
    }
  });

  it('51개 동률 근접 코멘트를 독립 keyset cursor로 중복·누락 없이 읽는다', async () => {
    const ids: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.hub({ id: studentId }, { limit: 20, commentsCursor: cursor }, Number.MAX_SAFE_INTEGER, false, false);
      ids.push(...page.comments.items.map(item => item.id));
      expect(page.comments.total).toBe(51);
      cursor = page.comments.nextCursor ?? undefined;
    } while (cursor);
    const expected = await ds.query(`SELECT id FROM note WHERE student_id=$1 ORDER BY created_at DESC,id DESC`, [studentId]) as Array<{ id: string }>;
    expect(ids).toHaveLength(51);
    expect(new Set(ids).size).toBe(51);
    expect(ids).toEqual(expected.map(row => Number(row.id)));
  });

  it('리포트·청구는 exact studentId이고 금액은 canMoney에서만 내려간다', async () => {
    const hidden = await service.hub({ id: studentId }, {}, Number.MAX_SAFE_INTEGER, false, false);
    const visible = await service.hub({ id: studentId }, {}, Number.MAX_SAFE_INTEGER, true, false);
    const other = await service.hub({ id: otherStudentId }, {}, Number.MAX_SAFE_INTEGER, true, false);
    expect(hidden.reports.items).toMatchObject([{ id: reportId, stateLabel: '승인 대기' }]);
    expect(hidden.invoices.items[0]).toMatchObject({ amount: null, paidAmount: null, remainingAmount: null });
    expect(visible.invoices.items[0]).toMatchObject({ dueOn: '2026-10-10', amount: 100000, paidAmount: 30000, remainingAmount: 70000 });
    expect(other.reports).toMatchObject({ total: 0, items: [] });
    expect(other.comments).toMatchObject({ total: 0, items: [] });
    expect(other.invoices).toMatchObject({ total: 0, items: [] });
    expect(hidden.teachers).toMatchObject([{ staffId, roleLabel: '매니저', lessons: [{ serId, ruleLabel: '매주 수', mode: 'online', fromDate: '2026-10-01', toDate: '2026-10-31' }] }]);
    expect(other.teachers).toEqual([]);
    expect(hidden.privateNoteCount).toBe(0);
    expect(other.commentLessons).toEqual([]);
  });

  it('from_date가 NULL인 현재 명단도 예정 수업에 포함한다', async () => {
    const [membership] = await ds.query(`SELECT from_date FROM ser_stu WHERE ser_id=$1 AND student_id=$2`, [serId, studentId]) as Array<{ from_date: string | null }>;
    expect(membership.from_date).toBeNull();
    const hub = await service.hub({ id: studentId }, {}, staffId, false, false);
    expect(hub.nextActions.find(item => item.key === 'schedule')).toMatchObject({ count: 1, stateLabel: '1회 예정' });
  });

  it('미래 회차 담당 override는 시리즈 기본 강사 대신 실제 강사 프로필로 연결한다', async () => {
    const [substitute] = await ds.query(`INSERT INTO staff(name,email,role,active)
      VALUES ('BOC04 대강 강사','boc04-substitute@test.local','teacher',true) RETURNING id`) as Array<{ id: string }>;
    const substituteId = Number(substitute.id);
    try {
      await ds.query(`UPDATE ser_occ SET teacher_id=$2 WHERE ser_id=$1`, [serId, substituteId]);
      const hub = await service.hub({ id: studentId }, {}, staffId, false, false);
      expect(hub.teachers).toHaveLength(1);
      expect(hub.teachers[0]).toMatchObject({ staffId: substituteId, name: 'BOC04 대강 강사', roleLabel: null,
        lessons: [{ serId, ruleLabel: expect.stringContaining('대체 회차'), mode: 'online' }] });
      expect(hub.teachers[0]?.lessons[0]?.toDate).toBe(hub.teachers[0]?.lessons[0]?.fromDate);
      expect(hub.teachers.some(teacher => teacher.staffId === staffId)).toBe(false);
    } finally {
      await ds.query(`UPDATE ser_occ SET teacher_id=$2 WHERE ser_id=$1`, [serId, staffId]);
      await ds.query(`DELETE FROM staff WHERE id=$1`, [substituteId]);
    }
  });

  it('지난 ONCE는 담당 강사에서 빼고 NOTE 연결용 전체 명단에는 종료 기간과 함께 남긴다', async () => {
    const [past] = await ds.query(`INSERT INTO ser(kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,title)
      VALUES ($1,$2,'offline',600,660,'ONCE',(now() AT TIME ZONE 'Asia/Seoul')::date-14,'BOC04 지난 단발') RETURNING id`, [kindKey, staffId]) as Array<{ id: string }>;
    const pastSerId = Number(past.id);
    try {
      await ds.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES ($1,$2)`, [pastSerId, studentId]);
      await ds.query(`INSERT INTO ser_occ(ser_id,on_date,teacher_id,span)
        SELECT $1,day,$2,tstzrange((day + time '10:00') AT TIME ZONE 'Asia/Seoul',
          (day + time '11:00') AT TIME ZONE 'Asia/Seoul','[)')
        FROM (SELECT (now() AT TIME ZONE 'Asia/Seoul')::date-14 AS day) past`, [pastSerId, staffId]);
      const hub = await service.hub({ id: studentId }, {}, staffId, false, false);
      expect(hub.teachers.flatMap(teacher => teacher.lessons.map(lesson => lesson.serId))).not.toContain(pastSerId);
      const historical = hub.commentLessons.find(lesson => lesson.serId === pastSerId);
      expect(historical).toMatchObject({ ended: true, fromDate: expect.any(String), toDate: expect.any(String) });
      expect(historical?.toDate).toBe(historical?.fromDate);

      await ds.query(`UPDATE ser_occ SET span=tstzrange(
        (((now() AT TIME ZONE 'Asia/Seoul')::date+9)+time '10:00') AT TIME ZONE 'Asia/Seoul',
        (((now() AT TIME ZONE 'Asia/Seoul')::date+9)+time '11:00') AT TIME ZONE 'Asia/Seoul','[)')
        WHERE ser_id=$1`, [pastSerId]);
      const moved = await service.hub({ id: studentId }, {}, staffId, false, false);
      expect(moved.teachers.flatMap(teacher => teacher.lessons.map(lesson => lesson.serId))).toContain(pastSerId);
      expect(moved.commentLessons).toContainEqual(expect.objectContaining({ serId: pastSerId, ended: false }));
    } finally {
      await ds.query(`DELETE FROM ser_occ WHERE ser_id=$1`, [pastSerId]);
      await ds.query(`DELETE FROM ser_stu WHERE ser_id=$1`, [pastSerId]);
      await ds.query(`DELETE FROM ser WHERE id=$1`, [pastSerId]);
    }
  });

  it('KST 자정 전후 NOTE를 각각 다른 월로 집계하고 월 cursor는 해당 월만 읽는다', async () => {
    const sepBefore = await service.hub({ id: studentId }, { commentsMonth: '2026-09' }, staffId, false, false);
    const octBefore = await service.hub({ id: studentId }, { commentsMonth: '2026-10' }, staffId, false, false);
    await ds.query(`INSERT INTO note(student_id,author_id,body,created_at) VALUES
      ($1,$2,'KST Sep boundary','2026-09-30T14:59:59Z'::timestamptz),
      ($1,$2,'KST Oct boundary','2026-09-30T15:00:00Z'::timestamptz)`, [studentId, staffId]);
    const sep = await service.hub({ id: studentId }, { commentsMonth: '2026-09' }, staffId, false, false);
    const oct = await service.hub({ id: studentId }, { commentsMonth: '2026-10' }, staffId, false, false);
    expect(sep.comments.total).toBe(sepBefore.comments.total + 1);
    expect(oct.comments.total).toBe(octBefore.comments.total + 1);
    expect(sep.comments.allTotal).toBe(sepBefore.comments.allTotal + 2);
    expect(sep.comments.months.find(item => item.month === '2026-09')?.total).toBe(sep.comments.total);
    expect(oct.comments.months.find(item => item.month === '2026-10')?.total).toBe(oct.comments.total);
    expect(sep.comments.items.map(item => item.body)).toEqual(['KST Sep boundary']);
    const octBodies: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.hub({ id: studentId }, { commentsMonth: '2026-10', commentsCursor: cursor, limit: 50 }, staffId, false, false);
      octBodies.push(...page.comments.items.map(item => item.body));
      cursor = page.comments.nextCursor ?? undefined;
    } while (cursor);
    expect(octBodies).toContain('KST Oct boundary');
    expect(octBodies).not.toContain('KST Sep boundary');
  });

  it('인수인계 본문은 학생 목록 검색어가 아니며 이름·학교·학년 검색 경계를 넘지 않는다', async () => {
    const result = await service.list({ q: 'note 17' });
    expect(result).toMatchObject({ total: 0, items: [] });
    const [stored] = await ds.query(`SELECT count(*)::int AS count FROM note WHERE student_id=$1 AND body=$2`, [studentId, 'BOC04 note 17']) as Array<{ count: number }>;
    expect(stored.count).toBe(1);
  });
});
