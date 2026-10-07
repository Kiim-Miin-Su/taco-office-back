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
      VALUES ($1,$2,'online',600,660,'FREQ=WEEKLY;BYDAY=WE','2026-10-01','2026-10-31','BOC04 cursor') RETURNING id`, [kindKey, staffId]) as Array<{ id: string }>;
    serId = Number(ser.id);
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
  });

  it('인수인계 본문은 학생 목록 검색어가 아니며 이름·학교·학년 검색 경계를 넘지 않는다', async () => {
    const result = await service.list({ q: 'note 17' });
    expect(result).toMatchObject({ total: 0, items: [] });
    const [stored] = await ds.query(`SELECT count(*)::int AS count FROM note WHERE student_id=$1 AND body=$2`, [studentId, 'BOC04 note 17']) as Array<{ count: number }>;
    expect(stored.count).toBe(1);
  });
});
