/** @file-guide
 * 목적: book-shelf-w11-db.spec.ts — §39 두 층 분류(N-47) · 등록과 첫 판 한 트랜잭션(N-61) · 배부 사유와 진단 한 줄(N-62) 회귀 (test · W11)
 * 책임/재사용: BooksService 공개 메서드를 실제 스크래치 DB 트랜잭션 안에서 부르고 되돌린다. 제품 규칙을 테스트에 다시 적지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 증명하는 것 —
 *   N-47 ① 옛 교재는 새 칸이 비어 「미분류」로 모이고, 보여 주는 레벨 · 학년은 옛 원문 그대로다(보정 0).
 *        ② 사람이 편집 창에서 과목 → 소분류 · 레벨 · 학년 범위 · 시험 태그를 정하면 카드 낱말이 원문 모양이 된다.
 *        ③ 필터는 서버가 걸고, 칩 건수는 서가 전체 기준이다(범위 교재는 덮는 학년마다 센다).
 *        ④ 다른 과목의 소분류 · 과목 없는 소분류 · 반쪽 학년 범위는 400 이다.
 *   N-61 등록 창의 첫 판 · SE/TE 파일은 교재와 한 트랜잭션 — 어디서든 막히면 교재 행도 파일도 안 남는다.
 *   N-62 배부 사유가 남고(§40 메모), 배부 창의 진단 한 줄은 최신 상담 진단을 읽기만 한다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BooksService } from '../src/modules/books/books.service';
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

const ACTOR = 9371;
const STUDENT = 9371;
const LONELY = 9372;
const b64 = (text: string) => Buffer.from(text).toString('base64');

d('§39 두 층 분류 · 첫 판 · 배부 사유 (W11 N-47 · N-61 · N-62)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const svc = () => new BooksService(q.manager.getRepository(Lead));
  const one = async (id: number) => (await svc().all()).items.find((item) => item.id === id);
  /** 옛 모양의 교재 한 권 — 옛 칸(level · grade)에 원문 값이 있고 새 분류 칸은 비어 있다 */
  const lib = async (code: string) => Number((await q.query(
    `INSERT INTO lib (code, title, level, grade) VALUES ($1, $2, 'AP', '11') RETURNING id`, [code, `${code} 교재`],
  ))[0].id);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES ($1,'서가 담당','shelf-w11@test','admin') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
    await q.query(`INSERT INTO stu (id,name) VALUES ($1,'배부 학생'),($2,'진단 없는 학생') ON CONFLICT (id) DO NOTHING`, [STUDENT, LONELY]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── N-47 ─────────────────────────────────────────────────────────────── */

  it('N-47 코드표는 원문 §39 컷의 과목 넷 · 보이는 소분류만이고 칩은 0 까지 모두 준다', async () => {
    const shelf = await svc().all();
    expect(shelf.subjects.map((s) => [s.key, s.label, s.color])).toEqual([
      ['english', 'English', '#2563EB'], ['math', 'Math', '#DC2626'],
      ['science', 'Science', '#16A34A'], ['social_studies', 'Social Studies', '#D97706'],
    ]);
    expect(shelf.subjects.map((s) => s.categories.map((c) => c.label))).toEqual([
      ['Reading', 'ELA', 'Grammar', 'Speaking & Interview', 'Writing'], ['General Math', 'Pre-Algebra'], ['Biology'], [],
    ]);
    expect(shelf.levelCounts.map((l) => l.label)).toEqual(['Foundation', 'Practice', 'Master']);
    expect(shelf.gradeCounts.map((g) => [g.key, g.grade])).toEqual(
      [['K', 0], ...Array.from({ length: 12 }, (_, n) => [`G${n + 1}`, n + 1])],
    );
    expect(shelf.examTags.map((t) => t.label)).toEqual(['SAT', 'MAP', 'ISEE / SSAT']);
    expect(shelf.unclassified).toMatchObject({ key: 'none', label: '미분류' });
  });

  it('N-47 옛 교재는 「미분류」로 모이고 보여 주는 레벨 · 학년은 옛 원문 그대로다 — 옛 칸은 한 글자도 안 바뀐다', async () => {
    const before = await svc().all();
    const id = await lib('W11-OLD');
    const after = await svc().all();
    expect(after.unclassified.count).toBe(before.unclassified.count + 1);
    expect(await one(id)).toMatchObject({
      bookSubjectKey: null, bookCategoryKey: null, bookLevel: null, gradeFrom: null, gradeTo: null, examTag: null,
      levelLabel: 'AP', gradeLabel: '11', level: 'AP', grade: '11',
    });
    // 코드표 칩은 옛 원문을 세지 않는다 — 짐작해 F/P/M 로 옮기지 않는다
    expect(after.levelCounts).toEqual(before.levelCounts);
  });

  it('N-47 사람이 편집 창에서 분류하면 카드 낱말이 원문 모양이 되고 원장에 앞뒤가 남는다', async () => {
    const id = await lib('W11-CLS');
    await svc().patchBook(ACTOR, id, {
      bookSubjectKey: 'english', bookCategoryKey: 'reading', bookLevel: 'practice', gradeFrom: 9, gradeTo: 10, examTag: 'isee_ssat',
    });
    expect(await one(id)).toMatchObject({
      bookSubjectName: 'English', bookSubjectColor: '#2563EB', bookCategoryName: 'Reading',
      bookLevel: 'practice', levelLabel: 'Practice', gradeFrom: 9, gradeTo: 10, gradeLabel: 'G9·G10',
      examTag: 'isee_ssat', examTagLabel: 'ISEE / SSAT',
      // 옛 칸은 그대로다(N-25)
      level: 'AP', grade: '11',
    });
    const [raw] = await q.query(`SELECT level, grade FROM lib WHERE id = $1`, [id]);
    expect(raw).toEqual({ level: 'AP', grade: '11' });
    const [log] = await q.query(`SELECT before, after FROM log WHERE entity = 'LIB' AND entity_id = $1 AND action = 'edit'`, [id]);
    expect(log.before).toEqual({ bookSubjectKey: null, bookCategoryKey: null, bookLevel: null, gradeFrom: null, gradeTo: null, examTag: null });
    expect(log.after).toMatchObject({ bookSubjectKey: 'english', bookCategoryKey: 'reading', gradeFrom: 9, gradeTo: 10 });
  });

  it('N-47 필터는 서버가 걸고 칩 건수는 서가 전체 기준이다 — 범위 교재는 덮는 학년마다 든다', async () => {
    const base = await svc().all();
    const eng = await lib('W11-ENG');
    const math = await lib('W11-MTH');
    const none = await lib('W11-NON');
    await svc().patchBook(ACTOR, eng, { bookSubjectKey: 'english', bookCategoryKey: 'grammar', bookLevel: 'foundation', gradeFrom: 6, gradeTo: 8 });
    await svc().patchBook(ACTOR, math, { bookSubjectKey: 'math', bookLevel: 'master', gradeFrom: 0, gradeTo: 0 });

    const full = await svc().all();
    const count = (list: Array<{ key: string; count: number }>, key: string) => list.find((x) => x.key === key)?.count ?? 0;
    expect(count(full.subjects, 'english')).toBe(count(base.subjects, 'english') + 1);
    expect(count(full.gradeCounts, 'G7')).toBe(count(base.gradeCounts, 'G7') + 1);
    expect(count(full.gradeCounts, 'K')).toBe(count(base.gradeCounts, 'K') + 1);
    expect(count(full.gradeCounts, 'G9')).toBe(count(base.gradeCounts, 'G9'));

    const ids = (items: Array<{ id: number }>) => items.map((item) => item.id);
    const english = await svc().all({ subject: 'english' });
    expect(ids(english.items)).toContain(eng);
    expect(ids(english.items)).not.toContain(math);
    expect(english.items.every((item) => item.bookSubjectKey === 'english')).toBe(true);
    // 칩을 골라도 다른 칩의 수는 서가 전체 그대로다
    expect(english.subjects).toEqual(full.subjects);
    expect(english.gradeCounts).toEqual(full.gradeCounts);

    const unclassified = await svc().all({ subject: 'none' });
    expect(ids(unclassified.items)).toContain(none);
    expect(unclassified.items.every((item) => item.bookSubjectKey === null)).toBe(true);

    expect(ids((await svc().all({ grade: 'G7' })).items)).toContain(eng);
    expect(ids((await svc().all({ grade: 'G9' })).items)).not.toContain(eng);
    expect(ids((await svc().all({ grade: 'K' })).items)).toEqual(expect.arrayContaining([math]));
    expect(ids((await svc().all({ level: 'master', subject: 'math' })).items)).toContain(math);
    expect(ids((await svc().all({ level: 'master', subject: 'english' })).items)).not.toContain(math);
  });

  it('N-47 차례는 과목 → 소분류 → 코드이고 「미분류」는 맨 뒤다', async () => {
    const a = await lib('W11-ORD-B');
    const b = await lib('W11-ORD-A');
    const c = await lib('W11-ORD-C');
    await svc().patchBook(ACTOR, a, { bookSubjectKey: 'english', bookCategoryKey: 'writing' });
    await svc().patchBook(ACTOR, b, { bookSubjectKey: 'english', bookCategoryKey: 'reading' });
    await svc().patchBook(ACTOR, c, { bookSubjectKey: 'math' });
    const order = (await svc().all()).items.map((item) => item.id);
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(a));
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(c));
    const firstUnclassified = (await svc().all()).items.findIndex((item) => item.bookSubjectKey === null);
    if (firstUnclassified >= 0) expect(order.indexOf(c)).toBeLessThan(firstUnclassified);
  });

  it('N-47 다른 과목의 소분류 · 과목 없는 소분류 · 없는 과목 · 반쪽 학년 범위는 400 이고 아무것도 안 바뀐다', async () => {
    const id = await lib('W11-BAD');
    await expect(svc().patchBook(ACTOR, id, { bookSubjectKey: 'math', bookCategoryKey: 'reading' }))
      .rejects.toMatchObject({ status: 400, response: { code: 'BOOK_CATEGORY_MISMATCH' } });
    await expect(svc().patchBook(ACTOR, id, { bookCategoryKey: 'reading' }))
      .rejects.toMatchObject({ status: 400, response: { code: 'BOOK_CATEGORY_NEEDS_SUBJECT' } });
    await expect(svc().patchBook(ACTOR, id, { bookSubjectKey: 'history' }))
      .rejects.toMatchObject({ status: 400, response: { code: 'BOOK_TAXONOMY_NOT_FOUND' } });
    await expect(svc().patchBook(ACTOR, id, { gradeFrom: 3 }))
      .rejects.toMatchObject({ status: 400, response: { code: 'BOOK_GRADE_RANGE' } });
    await expect(svc().patchBook(ACTOR, id, { gradeFrom: 7, gradeTo: 5 }))
      .rejects.toMatchObject({ status: 400, response: { code: 'BOOK_GRADE_RANGE' } });
    // 과목만 바꾸면 옛 소분류가 다른 과목의 것이 된다 — 편집 창은 둘을 함께 보낸다
    await svc().patchBook(ACTOR, id, { bookSubjectKey: 'english', bookCategoryKey: 'ela' });
    await expect(svc().patchBook(ACTOR, id, { bookSubjectKey: 'math' }))
      .rejects.toMatchObject({ status: 400, response: { code: 'BOOK_CATEGORY_MISMATCH' } });
    // 과목을 비우면 소분류도 함께 비워야 한다
    await expect(svc().patchBook(ACTOR, id, { bookSubjectKey: null }))
      .rejects.toMatchObject({ status: 400, response: { code: 'BOOK_CATEGORY_NEEDS_SUBJECT' } });
    await svc().patchBook(ACTOR, id, { bookSubjectKey: null, bookCategoryKey: null });
    expect(await one(id)).toMatchObject({ bookSubjectKey: null, bookCategoryKey: null });
    const logs = await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'LIB' AND entity_id = $1`, [id]);
    expect(logs[0].n).toBe(2);
  });

  it('N-47 등록도 같은 분류 검사를 거친다 — 등록 창에서 바로 분류할 수 있다', async () => {
    const made = await svc().createBook(ACTOR, {
      code: 'W11-NEW', title: '새 교재', bookSubjectKey: 'science', bookCategoryKey: 'biology', bookLevel: 'master',
      gradeFrom: 11, gradeTo: 12, examTag: 'sat',
    });
    expect(await one(made.id)).toMatchObject({ bookCategoryName: 'Biology', levelLabel: 'Master', gradeLabel: 'G11·G12', examTagLabel: 'SAT' });
    await expect(svc().createBook(ACTOR, { code: 'W11-NEW-2', title: 'x', bookSubjectKey: 'science', bookCategoryKey: 'reading' }))
      .rejects.toMatchObject({ response: { code: 'BOOK_CATEGORY_MISMATCH' } });
    await expect(svc().createBook(ACTOR, { code: 'W11-NEW-3', title: 'x', gradeTo: 4 }))
      .rejects.toMatchObject({ response: { code: 'BOOK_GRADE_RANGE' } });
    expect((await q.query(`SELECT count(*)::int AS n FROM lib WHERE code IN ('W11-NEW-2','W11-NEW-3')`))[0].n).toBe(0);
  });

  it('N-47 트래킹 · 자료 전달의 레벨은 코드표 레벨이 있으면 그 낱말, 아직이면 옛 원문이다', async () => {
    const classified = await lib('W11-TRK-A');
    const legacy = await lib('W11-TRK-B');
    await svc().patchBook(ACTOR, classified, { bookLevel: 'foundation' });
    await svc().createIssue(ACTOR, { libId: classified, studentId: STUDENT });
    await svc().createIssue(ACTOR, { libId: legacy, studentId: STUDENT });
    const books = (await svc().tracking()).books;
    expect(books.find((b) => b.libId === classified)?.level).toBe('Foundation');
    expect(books.find((b) => b.libId === legacy)?.level).toBe('AP');
  });

  /* ── N-61 ─────────────────────────────────────────────────────────────── */

  it('N-61 등록 창의 첫 판 · SE/TE 파일은 교재와 같은 트랜잭션에 저장된다', async () => {
    const made = await svc().createBook(ACTOR, {
      code: 'W11-FV', title: '첫 판 교재',
      firstVersion: {
        edition: 'v2026.09', fromDate: '2026-09-01',
        seFile: { kind: 'lib-se', name: '학생용.pdf', base64: b64('student') },
        teFile: { kind: 'lib-te', name: '교사용.pdf', base64: b64('teacher') },
      },
    });
    const book = await one(made.id);
    expect(book).toMatchObject({ edition: 'v2026.09', seFileId: expect.any(Number), teFileId: expect.any(Number), hasNewer: false });
    const hist = await q.query(
      `SELECT entity, action FROM hist WHERE (entity = 'lib' AND ref_id = $1) OR (entity = 'vers' AND ref_id = $2) ORDER BY entity`,
      [made.id, book?.versId],
    );
    expect(hist).toEqual([{ entity: 'lib', action: 'book_upload' }, { entity: 'vers', action: 'book_upload' }]);
  });

  it('N-61 첫 판 파일이 막히면(종류 · 합계 크기) 교재 행 · 판 · 파일 · 이력이 하나도 안 남는다', async () => {
    const count = async () => (await q.query(`SELECT
      (SELECT count(*)::int FROM lib WHERE code LIKE 'W11-FV-BAD%') AS libs,
      (SELECT count(*)::int FROM file) AS files,
      (SELECT count(*)::int FROM hist) AS hist`))[0];
    const before = await count();
    await expect(svc().createBook(ACTOR, {
      code: 'W11-FV-BAD1', title: 'x',
      firstVersion: { edition: 'v1', teFile: { kind: 'lib-se', name: 'te.pdf', base64: b64('te') } },
    })).rejects.toMatchObject({ response: { code: 'BOOK_FILE_KIND_MISMATCH' } });
    await expect(svc().createBook(ACTOR, {
      code: 'W11-FV-BAD2', title: 'x',
      firstVersion: {
        edition: 'v1',
        seFile: { kind: 'lib-se', name: 'se.pdf', base64: Buffer.alloc(2_000_000, 1).toString('base64') },
        teFile: { kind: 'lib-te', name: 'te.pdf', base64: Buffer.alloc(1_000_001, 2).toString('base64') },
      },
    })).rejects.toMatchObject({ status: 413, response: { code: 'BOOK_FILES_TOO_LARGE' } });
    expect(await count()).toEqual(before);
  });

  it('N-61 첫 판 없이도 등록은 그대로다 — 판 이름을 지어 넣지 않는다', async () => {
    const made = await svc().createBook(ACTOR, { code: 'W11-NOV', title: '판 없는 교재' });
    expect(await one(made.id)).toMatchObject({ edition: null, versId: null });
  });

  /* ── N-62 ─────────────────────────────────────────────────────────────── */

  it('N-62 배부 사유가 남고 §40 이력의 「교재 배부」 줄 메모로 읽힌다 — 빈 사유는 NULL 이다', async () => {
    const a = await lib('W11-RSN-A');
    const b = await lib('W11-RSN-B');
    const given = await svc().createIssue(ACTOR, { libId: a, studentId: STUDENT, reason: '  진단 결과 Reading 보강  ' });
    expect(given.reason).toBe('진단 결과 Reading 보강');
    const blank = await svc().createIssue(ACTOR, { libId: b, studentId: STUDENT, reason: '   ' });
    expect(blank.reason).toBeNull();
    const [row] = await q.query(`SELECT reason FROM issue WHERE id = $1`, [blank.id]);
    expect(row.reason).toBeNull();
    const line = (await svc().historyBoard({ span: 'all', action: 'book_issue' })).items.find((item) => item.refId === given.id);
    expect(line?.memo).toBe('진단 결과 Reading 보강');
    // 회수 줄에는 사유를 붙이지 않는다 — 사유는 「왜 줬는가」다
    await svc().returnIssue(ACTOR, given.id);
    const drop = (await svc().historyBoard({ span: 'all', action: 'book_drop' })).items.find((item) => item.refId === given.id);
    expect(drop?.memo).toBeNull();
  });

  it('N-62 배부 창의 진단 한 줄은 그 학생의 최신 상담 진단을 읽기만 한다 — 없으면 null · 없는 학생은 404', async () => {
    const [lead] = await q.query(
      `INSERT INTO lead (name, school, stage, owner_id, student_id) VALUES ('배부 학생','시험고','enrolled',$1,$2) RETURNING id`, [ACTOR, STUDENT],
    );
    await q.query(`INSERT INTO lead_diag (lead_id, english, math, interview, level, created_by) VALUES ($1, 50, 60, 40, NULL, $2)`, [lead.id, ACTOR]);
    await q.query(`INSERT INTO lead_diag (lead_id, english, math, interview, level, created_by) VALUES ($1, 32, NULL, 58, 'foundation', $2)`, [lead.id, ACTOR]);
    const issues = Number((await q.query(`SELECT count(*)::int AS n FROM issue`))[0].n);
    const got = await svc().latestDiag(STUDENT);
    expect(got).toMatchObject({ studentId: STUDENT, diag: { english: 32, math: null, interview: 58, levelLabel: 'Foundation' } });
    expect(await svc().latestDiag(LONELY)).toEqual({ studentId: LONELY, diag: null });
    await expect(svc().latestDiag(987654321)).rejects.toMatchObject({ status: 404 });
    // 읽기는 배부를 만들지도 점수를 옮겨 적지도 않는다(D-R22)
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM issue`))[0].n)).toBe(issues);
  });

  /* ── A' 후속 · 7-3 §38-2 배부 형태(리드 채택 · issue.form) ───────────────── */

  it('§38-2 배부 창에서 고른 형태가 남고 칩 낱말은 서버가 만든다 — 승인 대기 요청에도 서고, 안 고르면 칩이 없다', async () => {
    const a = await lib('W11-FORM-A');
    const b = await lib('W11-FORM-B');
    const c = await lib('W11-FORM-C');
    const print = await svc().createIssue(ACTOR, { libId: a, studentId: STUDENT, state: 'wait', form: 'print' });
    expect(print).toMatchObject({ state: 'wait', form: 'print', formLabel: '실물 책' });
    const pdf = await svc().createIssue(ACTOR, { libId: b, studentId: STUDENT, form: 'pdf' });
    expect(pdf).toMatchObject({ state: 'ok', form: 'pdf', formLabel: 'PDF' });
    const none = await svc().createIssue(ACTOR, { libId: c, studentId: STUDENT });
    expect(none).toMatchObject({ form: null, formLabel: null });
    const tracking = await svc().tracking();
    expect(tracking.issueForms).toEqual([{ key: 'pdf', label: 'PDF' }, { key: 'print', label: '실물 책' }]);
    const row = tracking.students.find((s) => s.id === STUDENT)!;
    const byLib = Object.fromEntries(row.issues.map((i) => [i.libId, i.formLabel ?? null]));
    expect(byLib).toMatchObject({ [a]: '실물 책', [b]: 'PDF', [c]: null });
    // 승인 대기 → 전달 대기로 옮겨도 형태는 그대로다
    await expect(svc().transitionIssue(ACTOR, print.id, 'auto')).resolves.toMatchObject({ form: 'print', formLabel: '실물 책' });
  });

  it('§38-2 표가 두 값 밖의 형태를 막는다 — 옛 배부 줄은 NULL 그대로(칩 없음)', async () => {
    const a = await lib('W11-FORM-D');
    await q.query('SAVEPOINT bad_form');
    await expect(q.query(`INSERT INTO issue (lib_id,student_id,state,form) VALUES ($1,$2,'wait','ebook')`, [a, STUDENT]))
      .rejects.toMatchObject({ constraint: 'issue_form_words' });
    await q.query('ROLLBACK TO SAVEPOINT bad_form');
    const [old] = await q.query(`INSERT INTO issue (lib_id,student_id,state) VALUES ($1,$2,'wait') RETURNING form`, [a, STUDENT]);
    expect(old.form).toBeNull();
  });
});
