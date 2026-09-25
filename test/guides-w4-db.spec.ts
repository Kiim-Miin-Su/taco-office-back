/** @file-guide
 * 목적: guides-w4-db.spec.ts — §43 할 일의 「안내 없음」 줄 · §44 학생별 진단 점수 카드를 실제 Postgres에서 검증한다 (test)
 * 책임/재사용: GuidesService 공개 메서드를 그대로 부른다. 누락 판정은 §45 와 같은 함수(candidateRows)라 테스트에 다시 쓰지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * g4 §43-2 — 원문 §43 「한 번」 목록은 필요한데 GUIDE 가 아직 없는 학생(「안내 없음」)도 세운다.
 *   전에는 GUIDE 가 있는 줄만 서서, 없는 학생은 §45 이력 탭 붉은 판에서만 초안을 만들 수 있었다.
 *   탭 배지(todoCount) = 목록 줄 수도 함께 지킨다 (§43-1 의 짝).
 * g4 §44-2 — DQ1(점수만 저장)의 영어·수학·인터뷰 점수를 학생별 화면에 카드 셋으로 싣는다.
 *   값은 상담 진단(lead_diag)을 `lead.student_id` 로 따라 읽는다 — DIAG 로 옮겨 적지 않는다(D-R22).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { addDays, todayKst } from '../src/lib/kst';
import { GuidesService } from '../src/modules/guides/guides.service';
import { GuideDirection1762500000000 } from '../src/migrations/1762500000000-guide-direction';
import { FakeSender } from './fake-sender';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

d('§43 안내 없음 줄 · §44 진단 점수 카드 (g4 43-2 · 44-2)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const manager = 2461;
  const teacher = 2462;
  const serId = -2461;
  const farSer = -2462;
  const kindKey = 'w4-guide';
  const subKey = 'w4-guide-sub';
  const leadId = 924610; // 상담 id 는 양의 안전 정수만 받는다(ops toId)
  const TODAY = todayKst();
  let s1 = 0;
  let s2 = 0;
  const svc = () => new GuidesService(q.manager.getRepository(Lead), new FakeSender());
  const occ = (ser: number, on: string) => q.query(
    `INSERT INTO ser_occ (ser_id,on_date,teacher_id,span)
     VALUES ($1,$2::date,$3, tstzrange(($2::date + interval '15 hours') AT TIME ZONE 'Asia/Seoul',
                                        ($2::date + interval '16 hours') AT TIME ZONE 'Asia/Seoul','[)'))`,
    [ser, on, teacher],
  );

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES
      ($1,'안내 매니저','w4-guide-manager@test','manager'),($2,'안내 강사','w4-guide-teacher@test','teacher')
      ON CONFLICT (id) DO NOTHING`, [manager, teacher]);
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'W4 안내 수업','#123456',8,'lesson',true)
      ON CONFLICT (key) DO NOTHING`, [kindKey]);
    await q.query(`INSERT INTO sub (key,name,color) VALUES ($1,'W4 Vocabulary','#654321') ON CONFLICT (key) DO NOTHING`, [subKey]);
    const made = await q.query(`INSERT INTO stu (name,grade) VALUES ('안내 하나','G9'),('안내 둘','G10') RETURNING id`);
    [s1, s2] = made.map((r: { id: string }) => Number(r.id));
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date)
      VALUES ($1,$2,$3,$4,'offline',900,960,'FREQ=WEEKLY',$5,$5)`, [serId, kindKey, subKey, teacher, TODAY]);
    for (const id of [s1, s2]) await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serId, id]);
    await occ(serId, TODAY);
    // 두 달 뒤 첫 수업 — 할 일 창(앞으로 7일) 밖이라 서지 않는다
    const far = addDays(TODAY, 60);
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date)
      VALUES ($1,$2,$3,$4,'offline',900,960,'FREQ=WEEKLY',$5,$5)`, [farSer, kindKey, subKey, teacher, far]);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [farSer, s1]);
    await occ(farSer, far);
  });
  afterEach(async () => { if (q?.isTransactionActive) await q.rollbackTransaction(); if (q && !q.isReleased) await q.release(); });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('43-2 GET /guides 는 안내가 필요한데 없는 학생을 missing 으로 싣고, 배지 수(todoCount)에 함께 센다', async () => {
    const all = await svc().all();
    const mine = all.missing.filter((row) => row.serId === serId);
    expect(mine.map((row) => row.studentId).sort()).toEqual([s1, s2].sort());
    expect(mine[0]).toMatchObject({ reason: 'new', eventOn: TODAY, subName: 'W4 Vocabulary', overdueDays: 0 });
    // 창 밖(두 달 뒤)의 첫 수업은 아직 할 일이 아니다
    expect(all.missing.some((row) => row.serId === farSer)).toBe(false);
    // 배지 = 목록: 안 보낸 안내 + 안내 없음 + 회차 안내 미기록
    const unsent = all.perLesson.filter((p) => !p.parentDeliveryRecorded || !p.teacherDeliveryRecorded).length;
    expect(all.todoCount).toBe(all.guides.filter((g) => g.pending).length + all.missing.length + unsent);
  });

  it('43-2 초안을 만들면 그 학생은 missing 에서 빠지고 pending 안내로 옮겨 간다 — 배지 수는 그대로', async () => {
    const before = await svc().all();
    const target = before.missing.find((row) => row.serId === serId && row.studentId === s1)!;
    await svc().createDraft(manager, { sourceOccurrenceId: target.sourceOccurrenceId, studentId: s1 });
    const after = await svc().all();
    expect(after.missing.some((row) => row.serId === serId && row.studentId === s1)).toBe(false);
    expect(after.guides.some((g) => g.serId === serId && g.studentId === s1 && g.pending)).toBe(true);
    expect(after.todoCount).toBe(before.todoCount);
  });

  it('43-2 강사 범위(teacherId)면 그 강사의 누락만 싣는다', async () => {
    const other = await svc().all(manager);
    expect(other.missing).toEqual([]);
    const own = await svc().all(teacher);
    expect(own.missing.length).toBeGreaterThanOrEqual(2);
  });

  it('44-2 학생별 화면은 등록된 상담 건의 최신 진단 점수(영어·수학·인터뷰)를 싣는다 — 없으면 null', async () => {
    await svc().createDraft(manager, {
      sourceOccurrenceId: (await svc().all()).missing.find((row) => row.studentId === s1)!.sourceOccurrenceId, studentId: s1,
    });
    await svc().createDraft(manager, {
      sourceOccurrenceId: (await svc().all()).missing.find((row) => row.studentId === s2)!.sourceOccurrenceId, studentId: s2,
    });
    await q.query(`INSERT INTO lead (id,name,school,stage,owner_id,student_id) VALUES ($1,'안내 하나','시험고','enrolled',$2,$3)`,
      [leadId, manager, s1]);
    await q.query(`INSERT INTO lead_diag (lead_id,english,math,interview,level,created_by) VALUES ($1,50,60,40,NULL,$2)`, [leadId, manager]);
    await q.query(`INSERT INTO lead_diag (lead_id,english,math,interview,level,created_by) VALUES ($1,62,71,58,'practice',$2)`, [leadId, manager]);
    const students = await svc().students();
    const first = students.items.find((item) => item.studentId === s1);
    // 최신 줄이 지금 값이다 (append-only)
    expect(first?.scores).toMatchObject({ english: 62, math: 71, interview: 58, level: 'practice' });
    expect(first?.scores?.levelLabel).toBeTruthy();
    expect(students.items.find((item) => item.studentId === s2)?.scores ?? null).toBeNull();
  });

  /**
   * g4 §44-3 — 원문 §44 는 안내 본문 한 상자가 아니라 **「지도 방향」**과 **「관리자 코멘트 · 강사만」** 두 상자다.
   * 둘 다 안내 작성과 같은 쓰기(PUT /guides/{id}/body)로 적고, 보낸 뒤에는 본문처럼 고칠 수 없다.
   * 안 보낸 칸은 그대로 두고(undefined), 빈 글자·null 은 비운다. 옛 안내는 NULL 이다(보정 0).
   */
  it('44-3 지도 방향·관리자 코멘트는 본문과 같은 쓰기로 적고, 보낸 칸만 바뀌며 빈 값은 비운다', async () => {
    const [target] = (await svc().all()).missing.filter((row) => row.serId === serId);
    const draft = await svc().createDraft(manager, { sourceOccurrenceId: target.sourceOccurrenceId, studentId: target.studentId });
    expect(draft).toMatchObject({ direction: null, adminNote: null });
    const written = await svc().writeBody(manager, draft.id, {
      body: '첫 수업 안내', direction: '  기준은 지키되 진도와 정서를 함께  ', adminNote: '어머님이 숙제 양에 민감합니다',
    });
    expect(written).toMatchObject({ body: '첫 수업 안내', direction: '기준은 지키되 진도와 정서를 함께', adminNote: '어머님이 숙제 양에 민감합니다' });
    // 안 보낸 칸은 그대로 — 본문만 고쳐도 두 상자는 남는다
    const bodyOnly = await svc().writeBody(manager, draft.id, { body: '고친 안내' });
    expect(bodyOnly).toMatchObject({ body: '고친 안내', direction: '기준은 지키되 진도와 정서를 함께', adminNote: '어머님이 숙제 양에 민감합니다' });
    // 빈 글자·null 은 비운다
    const cleared = await svc().writeBody(manager, draft.id, { body: '고친 안내', direction: '   ', adminNote: null });
    expect(cleared).toMatchObject({ direction: null, adminNote: null });
    const [row] = await q.query(`SELECT direction, admin_note FROM guide WHERE id=$1`, [draft.id]);
    expect(row).toEqual({ direction: null, admin_note: null });
    // §44 학생별도 같은 두 칸을 싣는다
    await svc().writeBody(manager, draft.id, { body: '고친 안내', direction: '엄격 + 관리' });
    const students = await svc().students();
    expect(students.items.find((item) => item.studentId === target.studentId)?.latestGuide.direction).toBe('엄격 + 관리');
  });

  it('44-3 표가 마지막으로 길이를 막는다 — 4000자 넘는 지도 방향은 저장되지 않는다', async () => {
    const [target] = (await svc().all()).missing.filter((row) => row.serId === serId);
    const draft = await svc().createDraft(manager, { sourceOccurrenceId: target.sourceOccurrenceId, studentId: target.studentId });
    await q.query('SAVEPOINT too_long');
    await expect(q.query(`UPDATE guide SET direction=$2 WHERE id=$1`, [draft.id, 'ㄱ'.repeat(4001)]))
      .rejects.toMatchObject({ constraint: 'guide_direction_len' });
    await q.query('ROLLBACK TO SAVEPOINT too_long');
    await expect(q.query(`UPDATE guide SET admin_note=$2 WHERE id=$1`, [draft.id, 'ㄱ'.repeat(4001)]))
      .rejects.toMatchObject({ constraint: 'guide_admin_note_len' });
  });

  it('44-3 마이그레이션 down 은 두 칸과 제약을 걷고 up 은 되살린다 — 옛 행은 건드리지 않는다', async () => {
    const cols = async () => (await q.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='guide' AND column_name IN ('direction','admin_note') ORDER BY 1`,
    )).map((r: { column_name: string }) => r.column_name);
    const before = Number((await q.query(`SELECT count(*) FROM guide`))[0].count);
    const migration = new GuideDirection1762500000000();
    expect(await cols()).toEqual(['admin_note', 'direction']);
    await migration.down(q);
    expect(await cols()).toEqual([]);
    await migration.up(q);
    expect(await cols()).toEqual(['admin_note', 'direction']);
    const cons = await q.query(
      `SELECT conname FROM pg_constraint WHERE conname IN ('guide_direction_len','guide_admin_note_len') ORDER BY 1`,
    );
    expect(cons.map((r: { conname: string }) => r.conname)).toEqual(['guide_admin_note_len', 'guide_direction_len']);
    expect(Number((await q.query(`SELECT count(*) FROM guide`))[0].count)).toBe(before);
  });
});
