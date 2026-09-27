/** @file-guide
 * 목적: book-level-w11-db.spec.ts — 강사 수업 안내 · §44 안내 학생별의 교재 레벨이 서가와 같은 함수(bookLevelShown)를 쓰는지 회귀 (test · W11 A' · N-47)
 * 책임/재사용: TeacherService · GuidesService 공개 메서드를 스크래치 DB 트랜잭션 안에서 부르고 되돌린다. 제품 규칙을 테스트에 다시 적지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * N-47 이 교재에 코드표 레벨(`lib.book_level`)을 더했지만, 강사 수업 안내(`teacher.service`)는 옛 칸(`lib.level`)만 읽었고
 * §44 안내 학생별(`guides.service`)은 레벨을 아예 싣지 않았다 — 사람이 분류해도 두 화면은 옛 원문이었다.
 * 이제 둘 다 서가 · 트래킹 · 자료 전달과 같은 `lib/book.bookLevelShown`(코드표 낱말 우선 · 없으면 옛 원문)이다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead, Ser } from '../src/entities';
import { todayKst } from '../src/lib/kst';
import { GuidesService } from '../src/modules/guides/guides.service';
import { TeacherService } from '../src/modules/teacher/teacher.service';
import { FakeSender } from './fake-sender';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

d('교재 레벨 낱말 — 강사 수업 안내 · §44 안내 학생별 (W11 A\' · N-47)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const manager = 9381;
  const teacher = 9382;
  const serId = -9381;
  const kindKey = 'w11-lvl';
  const subKey = 'w11-lvl-sub';
  const TODAY = todayKst();
  let student = 0;
  let classified = 0;
  let legacy = 0;
  const guides = () => new GuidesService(q.manager.getRepository(Lead), new FakeSender());
  const teachers = () => new TeacherService(q.manager.getRepository(Ser));

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES
      ($1,'레벨 매니저','w11-level-manager@test','manager'),($2,'레벨 강사','w11-level-teacher@test','teacher')
      ON CONFLICT (id) DO NOTHING`, [manager, teacher]);
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'W11 레벨 수업','#123456',8,'lesson',true)
      ON CONFLICT (key) DO NOTHING`, [kindKey]);
    await q.query(`INSERT INTO sub (key,name,color) VALUES ($1,'W11 Reading','#654321') ON CONFLICT (key) DO NOTHING`, [subKey]);
    [student] = (await q.query(`INSERT INTO stu (name,grade) VALUES ('레벨 학생','G9') RETURNING id`))
      .map((r: { id: string }) => Number(r.id));
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date)
      VALUES ($1,$2,$3,$4,'offline',900,960,'FREQ=WEEKLY',$5,$5)`, [serId, kindKey, subKey, teacher, TODAY]);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serId, student]);
    await q.query(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,span)
       VALUES ($1,$2::date,$3, tstzrange(($2::date + interval '15 hours') AT TIME ZONE 'Asia/Seoul',
                                          ($2::date + interval '16 hours') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [serId, TODAY, teacher],
    );
    // 사람이 분류한 교재(코드표 레벨 practice · 옛 원문 AP 는 그대로)와 아직 분류 안 된 옛 교재(원문 AP)
    [classified] = (await q.query(
      `INSERT INTO lib (code,title,level,grade,book_level) VALUES ('W11-LVL-A','분류한 교재','AP','11','practice') RETURNING id`,
    )).map((r: { id: string }) => Number(r.id));
    [legacy] = (await q.query(
      `INSERT INTO lib (code,title,level,grade) VALUES ('W11-LVL-B','옛 교재','AP','11') RETURNING id`,
    )).map((r: { id: string }) => Number(r.id));
    for (const lib of [classified, legacy]) {
      await q.query(`INSERT INTO issue (lib_id,student_id,issued_on,state) VALUES ($1,$2,$3::date,'ok')`, [lib, student, TODAY]);
    }
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const levels = (books: Array<{ title: string; level?: string | null }>) =>
    Object.fromEntries(books.map((b) => [b.title, b.level ?? null]));

  it('강사 수업 안내의 교재 레벨은 코드표 낱말이 먼저고, 아직 분류 안 된 교재는 옛 원문 그대로다', async () => {
    const got = await teachers().guides(teacher);
    const mine = got.students.find((s) => s.studentId === student);
    expect(levels(mine?.books ?? [])).toEqual({ '분류한 교재': 'Practice', '옛 교재': 'AP' });
  });

  it('§44 안내 학생별 교재 줄도 같은 낱말을 싣는다 — 레벨 사각이 서가와 갈리지 않는다', async () => {
    const all = await guides().all();
    const target = all.missing.find((row) => row.serId === serId && row.studentId === student)!;
    await guides().createDraft(manager, { sourceOccurrenceId: target.sourceOccurrenceId, studentId: student });
    const students = await guides().students();
    const mine = students.items.find((item) => item.studentId === student);
    expect(levels(mine?.books ?? [])).toEqual({ '분류한 교재': 'Practice', '옛 교재': 'AP' });
  });
});
