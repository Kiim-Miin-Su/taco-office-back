/** @file-guide
 * 목적: teacher-diag-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 진단 리포트 작성 — C61 (강사 원문 슬라이드 20 「04 진단 리포트」 · 47 권한 표).
 *
 * 증명하는 것 넷 —
 *   ① **역할만으로는 못 쓴다.** 강사여도 **내 학생**이 아니면 막힌다 — 남의 학생인지
 *      없는 학생인지도 구분해 주지 않는다(존재 누출 금지).
 *   ② **담당 판정이 수업 안내와 같은 식이다.** 회차 담당이 있으면 그것, 없으면 시리즈 담당.
 *      두 곳이 따로 판정하면 「안내에는 보이는데 진단은 못 쓰는 학생」이 생긴다.
 *   ③ **고치지 않고 쌓는다.** 읽기는 늘 최신 한 건이다.
 *   ④ **원문이 준 칸 넷이 다 내려간다** — 특히 「권장 커리큘럼」. 그동안 읽기가 그 칸을 빼고 있었다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Ser } from '../src/entities';
import { TeacherService } from '../src/modules/teacher/teacher.service';
import { addDays, todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions, url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

const MINE = 81;   // 나 — 시리즈 담당
const OTHER = 82;  // 남 — 다른 학생의 담당
const A = 91;      // 내 학생 (시리즈 담당으로)
const B = 92;      // 회차 담당만 나인 학생 — 안내와 같은 판정인지 본다
const C = 93;      // 남의 학생

d('진단 리포트 작성 (C61)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let serMine = 0;
  let serOther = 0;
  const svc = () => new TeacherService(q.manager.getRepository(Ser));

  const makeSeries = async (teacherId: number | null, occTeacher: number | null, studentId: number) => {
    const [s] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, teacher_id, mode, start_min, end_min, rrule, from_date)
       VALUES ('diag_test','diag_test_sub',$1,'offline',600,660,'FREQ=WEEKLY;BYDAY=MO',$2::date) RETURNING id`,
      [teacherId, todayKst()],
    )) as Array<{ id: string }>;
    const serId = Number(s.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [serId, studentId]);
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, span)
       VALUES ($1, $2::date, $3, tstzrange(($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul',
                                           ($2::date + time '11:00') AT TIME ZONE 'Asia/Seoul'))`,
      [serId, todayKst(), occTeacher],
    );
    return serId;
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM diag`);
    await q.query(`DELETE FROM ser_stu`);
    await q.query(`DELETE FROM ser_occ`);
    await q.query(`DELETE FROM ser`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES
         (${MINE},'나 강사','d81@t.kr','teacher'), (${OTHER},'남 강사','d82@t.kr','teacher')
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO stu (id,name,grade) VALUES (${A},'가 학생','G9'),(${B},'나 학생','G8'),(${C},'다 학생','G7')
       ON CONFLICT (id) DO NOTHING`,
    );
    // 이 시험만의 종류·과목 — 다른 시험이 코드표를 비워도 여기는 서지 않는다
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('diag_test','진단 시험용','#6F798A',4,'lesson')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color,kind_key) VALUES ('diag_test_sub','진단 시험 과목','#A85764','diag_test')
       ON CONFLICT (key) DO NOTHING`,
    );
    serMine = await makeSeries(MINE, null, A);      // 시리즈 담당이 나
    await makeSeries(OTHER, MINE, B);               // 시리즈는 남, 그날 회차는 나 — 안내에도 보이는 학생
    serOther = await makeSeries(OTHER, null, C);    // 남의 학생
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const write = (studentId: number, extra: Record<string, unknown> = {}) =>
    svc().createDiagnostic(MINE, { studentId, levelSummary: 'MAP 220 수준', ...extra });

  /**
   * B1014-04 안내 reader는 끝나지 않은 회차가 남은 담당자에게만 최신 NOTE·진단·프로필을 연다(upper(span) > now()).
   * makeSeries의 오늘 10:00–11:00 회차 하나만 두면 11시 이후 실행에서 현재 담당이 아니게 되어 시험이 시각에 따라 갈린다.
   * 주간 반복이 이어지는 실제 투영처럼 다음 주 회차를 하나 더 둔다(S5a 2026-10-16 — 제품 판정은 그대로).
   */
  const continueSeries = (serId: number) => q.query(
    `INSERT INTO ser_occ (ser_id, on_date, span)
     VALUES ($1, $2::date, tstzrange(($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul',
                                     ($2::date + time '11:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
    [serId, addDays(todayKst(), 7)],
  );

  /* ── ① 내 학생만 ─────────────────────────────────────────────────── */

  it('내 학생이면 쓴다 — 원문 04 의 네 칸이 그대로 돌아온다', async () => {
    const v = await write(A, {
      strengths: '어휘가 또래보다 넓다',
      weaknesses: '긴 지문에서 집중이 흐트러진다',
      curriculum: 'MAP Reading 주 2회 + Vocabulary 주 1회',
    });
    expect(v.levelSummary).toBe('MAP 220 수준');
    expect(v.strengths).toBe('어휘가 또래보다 넓다');
    expect(v.weaknesses).toBe('긴 지문에서 집중이 흐트러진다');
    expect(v.curriculum).toBe('MAP Reading 주 2회 + Vocabulary 주 1회');
    expect(v.byName).toBe('나 강사');
    expect(v.onDate).toBe(todayKst());
  });

  it('남의 학생은 못 쓴다 — 없는 학생과 같은 말로 돌려보낸다 (존재 누출 금지)', async () => {
    await expect(write(C)).rejects.toMatchObject({ status: 404 });
    await expect(write(999_999)).rejects.toMatchObject({ status: 404 });
    const [{ n }] = (await q.query(`SELECT count(*)::int AS n FROM diag`)) as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  /* ── ② 안내와 같은 담당 판정 ─────────────────────────────────────── */

  it('회차 담당만 나인 학생도 쓸 수 있다 — 수업 안내에 보이는 학생과 같은 집합이다', async () => {
    const v = await write(B);
    expect(v.levelSummary).toBe('MAP 220 수준');
    const { students } = await svc().guides(MINE);
    // 안내에 보이는 학생과 진단을 쓸 수 있는 학생이 갈리면 안 된다
    expect(students.map((s) => s.studentId).sort()).toEqual([A, B]);
  });

  it('남의 회차를 근거로 달 수 없다 — serId 도 내 수업인지 본다', async () => {
    await expect(write(A, { serId: serOther })).rejects.toMatchObject({ status: 404 });
    await expect(write(A, { serId: serMine })).resolves.toMatchObject({ levelSummary: 'MAP 220 수준' });
  });

  /* ── ③ 쌓는다 · 읽기는 최신 하나 ─────────────────────────────────── */

  it('다시 써도 앞의 것을 덮지 않는다 — 그때의 판단이 사라지면 안 된다', async () => {
    await write(A, { levelSummary: '첫 진단' });
    await write(A, { levelSummary: '두 번째 진단' });
    const [{ n }] = (await q.query(`SELECT count(*)::int AS n FROM diag WHERE student_id = ${A}`)) as Array<{ n: number }>;
    expect(n).toBe(2);
  });

  it('수업 안내가 읽는 것은 **최신 한 건**이다 — 쌓아도 화면이 안 어지럽다', async () => {
    await write(A, { levelSummary: '첫 진단' });
    await write(A, { levelSummary: '두 번째 진단', curriculum: '주 3회로 올림' });
    await continueSeries(serMine);
    const { students } = await svc().guides(MINE);
    const s = students.find((x) => x.studentId === A)!;
    expect(s.diag?.levelSummary).toBe('두 번째 진단');
    expect(s.diag?.curriculum).toBe('주 3회로 올림');
    expect(s.diag?.byName).toBe('나 강사');
  });

  it('과거 주의 전임 강사는 회차만 보며 교체 뒤 NOTE·진단·현재 프로필은 현 담당자에게만 열린다', async () => {
    await write(A, { levelSummary: '교체 뒤 최신 진단' });
    const [author] = await q.query(`INSERT INTO staff(name,email,role)
      VALUES ('인수인계 관리자','diag-note-manager@test.local','manager') RETURNING id`) as Array<{ id: string }>;
    await q.query(`INSERT INTO note(student_id,author_id,body) VALUES ($1,$2,'교체 뒤 새 인수인계')`, [A, author.id]);
    await q.query(`UPDATE stu SET guidance='intensive',lang='en',target_exam='TOEFL' WHERE id=$1`, [A]);
    const past = addDays(todayKst(), -14);
    await q.query(`UPDATE ser SET from_date=$2::date,to_date=$2::date WHERE id=$1`, [serMine, past]);
    await q.query(`UPDATE ser_occ SET on_date=$2::date,
      span=tstzrange(($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul',
        ($2::date + time '11:00') AT TIME ZONE 'Asia/Seoul','[)') WHERE ser_id=$1`, [serMine, past]);
    await q.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES ($1,$2)`, [serOther, A]);
    await continueSeries(serOther);

    const historical = (await svc().guides(MINE, past)).students.find(student => student.studentId === A);
    expect(historical?.lessons).toHaveLength(1);
    expect(historical).toMatchObject({ notes: [], books: [], diag: null, grade: null, school: null,
      targetExam: null, guidance: null, lang: null });

    const current = (await svc().guides(OTHER, todayKst())).students.find(student => student.studentId === A);
    expect(current?.notes).toMatchObject([{ body: '교체 뒤 새 인수인계' }]);
    expect(current?.diag).toMatchObject({ levelSummary: '교체 뒤 최신 진단' });
    expect(current).toMatchObject({ guidance: 'intensive', lang: 'en', targetExam: 'TOEFL' });
  });

  it.each([
    ['그날만 빠짐', 'excluded'],
    ['휴원', 'paused'],
  ])('유일한 미래 회차가 %s이면 미래 안내에서 빠지고 과거 안내에 최신 NOTE·진단을 열지 않는다', async (_label, reason) => {
    await write(A, { levelSummary: '미래 회차 비공개 진단' });
    const [author] = await q.query(`INSERT INTO staff(name,email,role)
      VALUES ('메모 관리자','diag-current-note-manager@test.local','manager') RETURNING id`) as Array<{ id: string }>;
    await q.query(`INSERT INTO note(student_id,author_id,body) VALUES ($1,$2,'미래 회차 비공개 NOTE')`, [A, author.id]);

    const past = addDays(todayKst(), -14);
    const future = addDays(todayKst(), 7);
    await q.query(`UPDATE ser SET from_date=$2::date WHERE id=$1`, [serMine, past]);
    await q.query(`UPDATE ser_occ SET on_date=$2::date,
      span=tstzrange(($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul',
        ($2::date + time '11:00') AT TIME ZONE 'Asia/Seoul','[)') WHERE ser_id=$1`, [serMine, past]);
    await q.query(`INSERT INTO ser_occ(ser_id,on_date,span) VALUES ($1,$2::date,
      tstzrange(($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul',
        ($2::date + time '11:00') AT TIME ZONE 'Asia/Seoul','[)'))`, [serMine, future]);

    if (reason === 'excluded') {
      const [exception] = await q.query(`INSERT INTO exc(ser_id,on_date,by_id)
        VALUES ($1,$2::date,$3) RETURNING id`, [serMine, future, author.id]) as Array<{ id: string }>;
      await q.query(`INSERT INTO exc_stu_out(exc_id,student_id) VALUES ($1,$2)`, [exception.id, A]);
    } else {
      await q.query(`INSERT INTO stu_pause(student_id,from_date,by_id) VALUES ($1,$2::date,$3)`, [A, future, author.id]);
    }

    const futureGuide = (await svc().guides(MINE, future)).students.find(student => student.studentId === A);
    expect(futureGuide).toBeUndefined();

    const historical = (await svc().guides(MINE, past)).students.find(student => student.studentId === A);
    expect(historical?.lessons).toHaveLength(1);
    expect(historical).toMatchObject({ notes: [], books: [], diag: null, grade: null, school: null,
      targetExam: null, guidance: null, lang: null });
  });

  /* ── ④ 칸과 거절 ─────────────────────────────────────────────────── */

  it('현재 수준이 비면 막는다 — 공백만 적은 것도 빈 것이다', async () => {
    await expect(write(A, { levelSummary: '   ' })).rejects.toMatchObject({ response: { code: 'EMPTY_BODY' } });
  });

  it('안 적은 칸은 null 이다 — 빈 문자열로 남기지 않는다', async () => {
    const v = await write(A, { strengths: '  ', curriculum: '' });
    expect(v.strengths).toBeNull();
    expect(v.weaknesses).toBeNull();
    expect(v.curriculum).toBeNull();
  });

  it('글자 수 하한을 두지 않는다 — 원문이 진단에는 안 적었다 (D-R44)', async () => {
    await expect(write(A, { levelSummary: '가' })).resolves.toMatchObject({ levelSummary: '가' });
  });
});
