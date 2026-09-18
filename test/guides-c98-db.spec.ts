/** @file-guide
 * 목적: §43 자동 채움 · 나머지 학생에게 복사 · 줌 안내를 실제 Postgres에서 검증한다 (C98).
 * 책임/재사용: GuidesService 공개 메서드와 migration 제약을 사용하며 테스트 규칙을 별도 구현하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 테스트 시나리오 **F-60**(첫 수업 안내 자동 채움 일곱 칸) · **F-61**(그룹 수업 안내 복사) ·
 * **F-63**(온라인 회차 줌 안내). 격리 DB 트랜잭션 안에서 돌고 끝나면 되돌린다.
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

d('§43 자동 채움 · 복사 · 줌 안내 (C98 · F-60 · F-61 · F-63)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const manager = 1981;
  const teacherA = 1982;
  const serId = -1981;
  const zaccId = -1981;
  const kindKey = 'c98-guide';
  const subKey = 'c98-sub';
  const libId = -1981;
  const TODAY = todayKst();
  let students: number[] = [];
  const svc = () => new GuidesService(q.manager.getRepository(Lead));

  /** 그날 그 학생의 초안 id */
  const draftOf = async (studentId: number): Promise<number> => {
    const [row] = await q.query(
      `SELECT id FROM guide WHERE ser_id=$1 AND event_on=$2::date AND student_id=$3 AND reason='new'`,
      [serId, TODAY, studentId],
    );
    return Number(row.id);
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES
      ($1,'안내 관리자','guide-manager-c98@test','manager'),
      ($2,'김재훈','guide-teacher-c98@test','teacher')
      ON CONFLICT (id) DO NOTHING`, [manager, teacherA]);
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'C98 수업','#123456',8,'lesson',true)
      ON CONFLICT (key) DO NOTHING`, [kindKey]);
    await q.query(`INSERT INTO sub (key,name,color) VALUES ($1,'SAT Reading','#654321')
      ON CONFLICT (key) DO NOTHING`, [subKey]);
    await q.query(`INSERT INTO zacc (id,label,login_email,login_secret,join_url,meeting_id,meeting_pw_enc,active)
      VALUES ($1,'Study','zoom-c98@test','\\x00','https://zoom.example/j/9988','998-877','\\x2a2a2a',true)
      ON CONFLICT (id) DO NOTHING`, [zaccId]);
    const made = await q.query(
      `INSERT INTO stu (name,grade) VALUES ('고은설','G9'),('이하린','G9'),('강라율','G8') RETURNING id`,
    );
    students = made.map((r: { id: string }) => Number(r.id));
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
      VALUES ($1,$2,$3,$4,'online',600,660,'FREQ=WEEKLY;BYDAY=TU',$5,NULL,'C98 그룹 수업')`,
    [serId, kindKey, subKey, teacherA, TODAY]);
    for (const id of students) await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serId, id]);
    await q.query(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,zacc_id,span)
       VALUES ($1,$2::date,$3,$4, tstzrange(($2::date + interval '10 hours') AT TIME ZONE 'Asia/Seoul',
                                            ($2::date + interval '11 hours') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [serId, TODAY, teacherA, zaccId],
    );
    // 교재는 첫 학생에게만 — 못 채운 칸이 어떻게 보이는지 함께 본다
    await q.query(`INSERT INTO lib (id,code,title,sub_key,se_te) VALUES ($1,'C98-1','SAT Reading Bible',$2,'SE')
      ON CONFLICT (id) DO NOTHING`, [libId, subKey]);
    await q.query(`INSERT INTO issue (student_id,lib_id,state,issued_on) VALUES ($1,$2,'ok',now())`, [students[0], libId]);
    // 세 학생의 첫 수업 초안 — §45 누락 판정과 같은 함수가 만든다
    await svc().draftsForStudent(q.manager, manager, students[0]);
    await svc().draftsForStudent(q.manager, manager, students[1]);
    await svc().draftsForStudent(q.manager, manager, students[2]);
  });
  afterEach(async () => { if (q?.isTransactionActive) await q.rollbackTransaction(); if (q && !q.isReleased) await q.release(); });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── F-60 자동 채움 ─────────────────────────────────────────────────────── */

  it('F-60 초안은 일곱 칸을 채워 오고 저장하지는 않는다 — 교재가 없는 학생은 왜 없는지를 적는다', async () => {
    const all = await svc().all();
    const withBooks = all.guides.find((g) => g.studentId === students[0]);
    const without = all.guides.find((g) => g.studentId === students[2]);
    expect(withBooks?.autoFill?.facts.map((f) => f.key)).toEqual(
      ['student', 'grade', 'teacher', 'subject', 'mode', 'startOn', 'books'],
    );
    expect(withBooks?.autoFill?.facts.map((f) => f.value)).toEqual(
      ['고은설', 'G9', '김재훈', 'SAT Reading', '온라인', TODAY, 'SAT Reading Bible'],
    );
    expect(withBooks?.autoFill?.facts.every((f) => f.filled)).toBe(true);
    // 교재가 없으면 값은 null 이고 문장은 서버가 준다
    const books = without?.autoFill?.facts.find((f) => f.key === 'books');
    expect(books).toMatchObject({ value: null, filled: false });
    expect(without?.autoFill?.body).toContain('교재가 아직 배정되지 않았습니다');
    expect(without?.autoFill?.body.startsWith('[첫 수업 안내]')).toBe(true);
    // **저장하지 않는다** — 표의 body 는 그대로 비어 있다
    const [row] = await q.query(`SELECT body FROM guide WHERE id=$1`, [withBooks!.id]);
    expect(row.body).toBeNull();
  });

  it('F-60 쓴 안내에는 자동 채움이 실리지 않는다 — 사람이 쓴 말이 정본이다', async () => {
    const id = await draftOf(students[0]);
    await svc().writeBody(manager, id, { body: '직접 쓴 안내' });
    const after = (await svc().all()).guides.find((g) => g.id === id);
    expect(after?.state).toBe('ready');
    expect(after?.autoFill ?? null).toBeNull();
  });

  /* ── F-61 나머지 학생에게 복사 ─────────────────────────────────────────── */

  it('F-61 복사는 머리말을 받는 학생 것으로 다시 만든다 — 남의 이름이 남지 않는다', async () => {
    const source = await draftOf(students[0]);
    const before = (await svc().all()).guides.find((g) => g.id === source);
    expect(before?.siblingCount).toBe(2);
    const body = `${before!.autoFill!.body}이번 주부터 시작합니다. 준비물은 없습니다.`;
    await svc().writeBody(manager, source, { body });

    const res = await svc().copyBody(manager, source);
    expect(res.headReplaced).toBe(true);
    expect(res.copied).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
    for (const copied of res.copied) {
      expect(copied.state).toBe('ready');
      expect(copied.body).toContain('이번 주부터 시작합니다');
      // 받는 학생의 이름으로 시작하고 원본 학생의 이름은 없다
      expect(copied.body).toContain(`학생 ${copied.studentName}`);
      expect(copied.body).not.toContain('학생 고은설');
    }
    // 학년이 다른 학생은 제 학년으로 적힌다 — 머리말을 통째로 옮기지 않았다는 증거
    const younger = res.copied.find((g) => g.studentId === students[2]);
    expect(younger?.body).toContain('학년 G8');
  });

  it('F-61 이미 쓴 형제는 덮지 않고 이유를 돌려준다 · 머리말이 다르면 본문만 옮긴다', async () => {
    const source = await draftOf(students[0]);
    const kept = await draftOf(students[1]);
    await svc().writeBody(manager, kept, { body: '이 학생 것은 따로 썼습니다' });
    await svc().writeBody(manager, source, { body: '머리말 없이 쓴 본문' });

    const res = await svc().copyBody(manager, source);
    expect(res.headReplaced).toBe(false);
    expect(res.copied.map((g) => g.studentId)).toEqual([students[2]]);
    expect(res.copied[0].body).toBe('머리말 없이 쓴 본문');
    expect(res.skipped).toEqual([
      expect.objectContaining({ id: kept, reason: '이미 쓴 안내라 덮지 않았습니다' }),
    ]);
    const [row] = await q.query(`SELECT body FROM guide WHERE id=$1`, [kept]);
    expect(row.body).toBe('이 학생 것은 따로 썼습니다');
  });

  it('F-61 아직 안 쓴 안내는 복사할 수 없고, 형제가 없으면 거절한다', async () => {
    const source = await draftOf(students[0]);
    await expect(svc().copyBody(manager, source)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GUIDE_COPY_EMPTY' }),
    });
    await q.query(`DELETE FROM guide WHERE ser_id=$1 AND student_id = ANY($2::bigint[])`, [serId, [students[1], students[2]]]);
    await svc().writeBody(manager, source, { body: '혼자 듣는 수업' });
    await expect(svc().copyBody(manager, source)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GUIDE_COPY_NO_SIBLING' }),
    });
  });

  /* ── F-63 줌 안내 ───────────────────────────────────────────────────────── */

  it('F-63 줌 안내는 강사에게 실제로 가고 학부모 줄은 보낼 것으로 남는다 · 비밀번호는 본문에 없다', async () => {
    const before = (await svc().all()).perLesson.find((row) => row.serId === serId);
    expect(before).toMatchObject({ canSendTeacher: true, sendBlockedReason: null, teacherDeliveryRecorded: false });

    const res = await svc().sendZoomNotice(manager, { serId, onDate: TODAY });
    expect(res).toMatchObject({ teacherNotices: 1, parentNotices: 3 });
    expect(res.lesson).toMatchObject({ teacherDeliveryRecorded: true, canSendTeacher: false, sendBlockedReason: '이미 보냈습니다' });

    const [t] = await q.query(
      `SELECT body, staff_id, student_id, sent_at FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='teacher'`,
      [serId, TODAY],
    );
    expect(Number(t.staff_id)).toBe(teacherA);
    expect(t.student_id).toBeNull();
    expect(t.sent_at).not.toBeNull();
    expect(t.body).toContain('https://zoom.example/j/9988');
    expect(t.body).toContain('Study');
    expect(t.body).toContain('998-877');
    // 암호화해 둔 비밀번호를 평문으로 옮기지 않는다
    expect(t.body).not.toContain('***');
    expect(t.body).not.toMatch(/비밀번호|password|pw/i);

    const parents = await q.query(
      `SELECT student_id, staff_id, sent_at FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='parent'`,
      [serId, TODAY],
    );
    expect(parents).toHaveLength(3);
    expect(parents.every((p: { sent_at: Date | null }) => p.sent_at === null)).toBe(true);
    expect(parents.every((p: { staff_id: string | null }) => p.staff_id === null)).toBe(true);

    // 강사 수신함에 한 건 — 내부 사용자라 실제로 간다
    const noti = await q.query(`SELECT body, link FROM noti WHERE to_id=$1`, [teacherA]);
    expect(noti).toHaveLength(1);
    expect(noti[0].link).toBe('/teacher');
  });

  it('F-63 두 번째는 부분 유니크가 막는다 — 앱이 다시 세지 않는다', async () => {
    await svc().sendZoomNotice(manager, { serId, onDate: TODAY });
    await expect(svc().sendZoomNotice(manager, { serId, onDate: TODAY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZOOM_NOTICE_ALREADY' }),
    });
    const [n] = await q.query(
      `SELECT count(*)::int AS n FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='teacher'`,
      [serId, TODAY],
    );
    expect(n.n).toBe(1);
  });

  it('F-63 현장 · 휴강 · 계정 없음 · 강사 없음은 각각 거절하고 단추도 서지 않는다', async () => {
    await q.query(`UPDATE ser_occ SET zacc_id=NULL WHERE ser_id=$1 AND on_date=$2::date`, [serId, TODAY]);
    let lesson = (await svc().all()).perLesson.find((row) => row.serId === serId);
    expect(lesson).toMatchObject({ canSendTeacher: false, sendBlockedReason: '줌 계정이 아직 배정되지 않았습니다' });
    await expect(svc().sendZoomNotice(manager, { serId, onDate: TODAY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZOOM_NOTICE_NO_ACCOUNT' }),
    });

    await q.query(`UPDATE ser_occ SET zacc_id=$3, teacher_id=NULL WHERE ser_id=$1 AND on_date=$2::date`, [serId, TODAY, zaccId]);
    lesson = (await svc().all()).perLesson.find((row) => row.serId === serId);
    expect(lesson).toMatchObject({ canSendTeacher: false, sendBlockedReason: '강사가 아직 정해지지 않았습니다' });
    await expect(svc().sendZoomNotice(manager, { serId, onDate: TODAY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZOOM_NOTICE_NO_TEACHER' }),
    });

    await q.query(`UPDATE ser_occ SET teacher_id=$3, canceled=true WHERE ser_id=$1 AND on_date=$2::date`, [serId, TODAY, teacherA]);
    await expect(svc().sendZoomNotice(manager, { serId, onDate: TODAY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZOOM_NOTICE_CANCELED' }),
    });

    await q.query(`UPDATE ser_occ SET canceled=false WHERE ser_id=$1 AND on_date=$2::date`, [serId, TODAY]);
    await q.query(`UPDATE ser SET mode='offline' WHERE id=$1`, [serId]);
    await expect(svc().sendZoomNotice(manager, { serId, onDate: TODAY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ZOOM_NOTICE_NOT_ONLINE' }),
    });
    // 현장 수업은 §43 회차 안내 목록에 아예 서지 않는다
    expect((await svc().all()).perLesson.find((row) => row.serId === serId)).toBeUndefined();
  });
});
