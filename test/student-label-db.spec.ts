/** @file-guide
 * 목적: student-label-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { GpaCycle, Inv, Kind, Room, Staff, Stu, Sub, Zacc } from '../src/entities';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { GpaService } from '../src/modules/gpa/gpa.service';
import { MetaService } from '../src/modules/meta/meta.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

/**
 * N-137 「같은 이름의 학생이 둘 → 구분할 수 있게 표시된다(학년 · 학교)」.
 * 일정 · 청구는 학생 번호로 갈려 섞이지 않는다 — 모자랐던 것은 **사람이 고르고 읽는 자리의 표기**다.
 * 꼬리 판정은 서버 한 곳(`lib/student-label.studentTagSql`)이고, 코드표 · GPA 보드 · 청구서 · §53 보드 · §54 표가 같은 조각을 싣는다.
 * 이 스위트는 학생을 번호 없이 넣는다(시퀀스가 준다) — 시드 번호 · 명시 id 를 빌리지 않는다.
 */
d('N-137 동명이인 표기 — 학년 · 학교 · 번호 꼬리', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const meta = () => new MetaService(
    q.manager.getRepository(Kind), q.manager.getRepository(Sub), q.manager.getRepository(Room),
    q.manager.getRepository(Zacc), q.manager.getRepository(Staff), q.manager.getRepository(Stu),
  );
  const acct = () => new AccountingService(q.manager.getRepository(Inv));
  const gpa = () => new GpaService(q.manager.getRepository(GpaCycle));
  const stu = async (name: string, grade: string | null, school: string | null): Promise<number> => {
    const [r] = (await q.query(`INSERT INTO stu (name, grade, school) VALUES ($1, $2, $3) RETURNING id`, [name, grade, school])) as Array<{ id: string }>;
    return Number(r.id);
  };

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('코드표 학생 — 홀로면 학년만, 같은 이름이 있으면 학교, 학교까지 같으면 번호, 없는 칸은 건너뛴다', async () => {
    const a = await stu('동명시험', 'G8', '채드윅');
    const b = await stu('동명시험', 'G9', '역삼중');
    const c = await stu('동명시험', 'G8', '채드윅');
    const solo = await stu('홀로시험', 'G7', '대치중');
    const bare = await stu('꼬리없음시험', null, null);
    const noSchool1 = await stu('학교없음시험', 'G5', null);
    const noSchool2 = await stu('학교없음시험', 'G6', '  ');

    const out = await meta().all(true);
    const by = new Map(out.students.map((s) => [s.id, s]));
    expect(by.get(a)).toMatchObject({ tag: `G8 · 채드윅 · #${a}`, label: `동명시험 · G8 · 채드윅 · #${a}` });
    expect(by.get(c)).toMatchObject({ tag: `G8 · 채드윅 · #${c}`, label: `동명시험 · G8 · 채드윅 · #${c}` });
    expect(by.get(b)).toMatchObject({ tag: 'G9 · 역삼중', label: '동명시험 · G9 · 역삼중' });
    // 동명이인이 없으면 학교를 붙이지 않는다 — 여러 고르기가 이미 쓰던 「이름 · 학년」 그대로
    expect(by.get(solo)).toMatchObject({ tag: 'G7', label: '홀로시험 · G7' });
    expect(by.get(bare)).toMatchObject({ tag: null, label: '꼬리없음시험' });
    // 같은 이름인데 학교가 비었다 — 학년이 갈라 주므로 번호는 붙지 않는다(공백만인 학교도 빈 칸이다)
    expect(by.get(noSchool1)).toMatchObject({ tag: 'G5', label: '학교없음시험 · G5' });
    expect(by.get(noSchool2)).toMatchObject({ tag: 'G6', label: '학교없음시험 · G6' });
    // 표기 칸이 늘었을 뿐 — 명단의 다른 칸(학년 · 학교 원문)은 그대로다
    expect(by.get(noSchool2)).toMatchObject({ grade: 'G6', school: '  ' });
  });

  it('관리 화면이 아니면 명단 자체가 없다 — 꼬리를 싣는다고 강사에게 학교가 가지 않는다', async () => {
    await stu('동명시험', 'G8', '채드윅');
    await stu('동명시험', 'G9', '역삼중');
    expect((await meta().all(false)).students).toEqual([]);
  });

  it('청구서 목록 · §53 보드 카드가 같은 꼬리를 싣는다 — 같은 이름 두 청구서를 가를 수 있다', async () => {
    const a = await stu('동명청구', 'G8', '채드윅');
    const b = await stu('동명청구', 'G8', '역삼중');
    const [ia] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state) VALUES ($1,'2031-03','tuition','3월 수업료',100000,'unpaid') RETURNING id`, [a],
    )) as Array<{ id: string }>;
    const [ib] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state) VALUES ($1,'2031-03','tuition','3월 수업료',100000,'unpaid') RETURNING id`, [b],
    )) as Array<{ id: string }>;

    const all = await acct().all(true, true);
    const row = (id: string) => all.invoices.find((i) => i.id === Number(id));
    expect(row(ia.id)).toMatchObject({ studentName: '동명청구', grade: 'G8', studentTag: 'G8 · 채드윅' });
    expect(row(ib.id)).toMatchObject({ studentName: '동명청구', grade: 'G8', studentTag: 'G8 · 역삼중' });

    const board = await acct().invoiceBoard(true);
    const cards = board.columns.flatMap((c) => c.cards);
    expect(cards.find((x) => x.invId === Number(ia.id))).toMatchObject({ studentTag: 'G8 · 채드윅' });
    expect(cards.find((x) => x.invId === Number(ib.id))).toMatchObject({ studentTag: 'G8 · 역삼중' });
  });

  it('GPA 보드 학생 — 기록 창의 학생 고르기가 꼬리 붙은 이름을 쓴다', async () => {
    const a = await stu('동명GPA', 'G10', '채드윅');
    const b = await stu('동명GPA', 'G10', '송도국제');
    const [cy] = (await q.query(
      `INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (97, '2031-03-03', '2031-03-30') RETURNING id`,
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO gpa_alloc (cycle_id, student_id, points) VALUES ($1,$2,8), ($1,$3,6)`, [cy.id, a, b]);

    const board = await gpa().board('2031-03-10');
    const by = new Map(board.students.map((s) => [s.studentId, s]));
    expect(by.get(a)).toMatchObject({ name: '동명GPA', tag: 'G10 · 채드윅', label: '동명GPA · G10 · 채드윅' });
    expect(by.get(b)).toMatchObject({ name: '동명GPA', tag: 'G10 · 송도국제', label: '동명GPA · G10 · 송도국제' });
  });
});
