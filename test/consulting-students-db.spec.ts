/** @file-guide
 * 목적: consulting-students-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §27 컨설팅 학생별 — C59.
 *
 * 증명하는 것 넷 —
 *   ① **원문 규칙 그대로** — 「csCan() 으로 볼 수 있는 것만 집계합니다」. 안 보이는 건은
 *      건수에도 합계에도 안 들어간다. 「컨설팅 2건」이라 적어 놓고 한 건만 보이면 안 된다.
 *   ② **세는 것은 서버다** (D-R37) — 기록 회차 · 끝낸 항목 · 받은 돈.
 *   ③ **학생이 여럿인 건은 그 학생들 모두의 줄에 걸린다** — 한 명에게만 붙이면 나머지가 사라진다.
 *   ④ **내용이 잠기면 항목 줄은 비지만 숫자는 산다** — 화면이 배열 길이를 세면 「항목 0/0」이 된다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import type { ConsStudentsDto } from '../src/modules/consulting/consulting.dto';
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

const OWNER = 61;
const OTHER = 62;
const A = 71; // 고은성 — 보이는 건 하나 + 숨은 건 하나
const B = 72; // 민제인 — 보이는 건 하나
const OPEN = 91;
const HIDDEN = 92;  // 지정 공개 — OTHER 에게는 없다
const PAY_ONLY = 93; // 수납만 공개 — 금액은 보이고 내용은 잠긴다
const SHARED = 94;   // 학생 둘이 같이 걸린 건

d('§27 컨설팅 학생별 (C59)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const svc = () => new ConsultingService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM inv WHERE cs_id IS NOT NULL`);
    await q.query(`DELETE FROM cons_pay`);
    await q.query(`DELETE FROM cons_stu`);
    await q.query(`DELETE FROM cons_pick`);
    await q.query(`DELETE FROM cons_item`);
    await q.query(`DELETE FROM cons_sess`);
    await q.query(`DELETE FROM cons`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title) VALUES
         (${OWNER},'담당','cs27-own@t.kr','manager','매니저'),
         (${OTHER},'남','cs27-oth@t.kr','manager','매니저')
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO stu (id,name,grade) VALUES (${A},'고은성','G12'),(${B},'민제인','G10')
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO cons (id, cons_type, stage, contract_step, amount, sessions, end_on, owner_id, share) VALUES
         (${OPEN},    'admissions','running', 5, 800000, 6, '2026-10-10', ${OWNER}, 'all'),
         (${HIDDEN},  'essay',     'running', 5, 500000, 4, NULL,         ${OWNER}, 'picked'),
         (${PAY_ONLY},'roadmap',   'running', 5, 300000, 3, NULL,         ${OWNER}, 'money_only'),
         (${SHARED},  'essay',     'contract',1, 900000, 2, NULL,         ${OWNER}, 'all')`,
    );
    await q.query(
      `INSERT INTO cons_stu (cons_id, student_id) VALUES
         (${OPEN},${A}), (${HIDDEN},${A}), (${PAY_ONLY},${A}), (${SHARED},${A}), (${SHARED},${B})`,
    );
    // 회차 둘 · 항목 일곱 중 넷 완료 — 원문 컷과 같은 「2/6 · 4/7」
    await q.query(`INSERT INTO cons_sess (cons_id, seq) VALUES (${OPEN},1),(${OPEN},2)`);
    const labels = ['지원서 작성', '학업 성적 공증', '추천서 2부', '자기소개 에세이', '활동 증빙 자료', '여권 사본', '재학 증명서'];
    for (const [i, label] of labels.entries()) {
      // 끝낸 항목은 누가 언제까지 함께 적혀야 한다 — 표가 그렇게 지킨다 (cons_item_done_stamp_check)
      await q.query(
        i < 4
          ? `INSERT INTO cons_item (cons_id, seq, label, done, done_by, done_at) VALUES ($1,$2,$3,true,${OWNER},now())`
          : `INSERT INTO cons_item (cons_id, seq, label, done) VALUES ($1,$2,$3,false)`,
        [OPEN, i + 1, label],
      );
    }
    await q.query(
      `INSERT INTO cons_pay (cons_id, amount, paid_on, by_id) VALUES
         (${OPEN}, 400000, '2026-07-12', ${OWNER}),
         (${HIDDEN}, 500000, '2026-07-12', ${OWNER})`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const boss = () => svc().students(OWNER, true, true);
  const stranger = () => svc().students(OTHER, true, false);
  const find = async (who: () => Promise<ConsStudentsDto>, id: number) =>
    (await who()).items.find((s) => s.studentId === id);

  /* ── ① 보이는 것만 센다 ───────────────────────────────────────────── */

  it("「csCan() 으로 볼 수 있는 것만 집계합니다」 — 안 보이는 건은 건수에서도 빠진다", async () => {
    expect((await find(boss, A))!.caseCount).toBe(4);
    // 남에게는 지정 공개 건이 없다 — 건수도 셋이다
    const mine = (await find(stranger, A))!;
    expect(mine.caseCount).toBe(3);
    expect(mine.cases.some((c) => c.id === HIDDEN)).toBe(false);
  });

  it('합계도 보이는 건만 더한다 — 합계로 가려진 금액이 드러나지 않는다', async () => {
    expect((await find(boss, A))!.paid).toBe(900000);    // 400,000 + 500,000(숨은 건)
    expect((await find(stranger, A))!.paid).toBe(400000); // 숨은 건은 빠진다
  });

  it('한 건도 안 보이는 사람에게는 학생 줄 자체가 없다', async () => {
    const { items } = await svc().students(OTHER, true, false);
    expect(items.length).toBeGreaterThan(0);
    await q.query(`UPDATE cons SET share = 'private'`);
    expect((await svc().students(OTHER, true, false)).items).toEqual([]);
    // 담당자에게는 그대로 보인다 — 공개 범위는 역할과 독립된 두 번째 층이다
    expect((await boss()).items.length).toBeGreaterThan(0);
  });

  /* ── ② 세는 것은 서버다 ──────────────────────────────────────────── */

  it('회차·항목·받은 돈을 서버가 센다 — 원문 컷의 「2/6 · 4/7」', async () => {
    const c = (await find(boss, A))!.cases.find((x) => x.id === OPEN)!;
    expect(c.sessionsLogged).toBe(2);
    expect(c.sessions).toBe(6);
    expect(c.itemsDone).toBe(4);
    expect(c.itemsTotal).toBe(7);
    expect(c.paid).toBe(400000);
    expect(c.amount).toBe(800000);
  });

  it('단계 이름과 담당·기간도 서버가 준다 — 코드값이 화면으로 새지 않는다 (D-R18)', async () => {
    const c = (await find(boss, A))!.cases.find((x) => x.id === OPEN)!;
    expect(c.stageLabel).toBe('진행');
    expect(c.ownerName).toBe('담당');
    expect(c.endOn).toBe('2026-10-10');
    expect(c.createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('학년을 그대로 내려보낸다 — 없으면 null 이고 빈 문자열로 뭉개지 않는다', async () => {
    expect((await find(boss, A))!.grade).toBe('G12');
    await q.query(`UPDATE stu SET grade = NULL WHERE id = ${B}`);
    expect((await find(boss, B))!.grade).toBeNull();
  });

  /* ── ③ 학생 여럿 ─────────────────────────────────────────────────── */

  it('학생이 둘인 건은 두 사람의 줄에 모두 걸린다 — 한 명에게만 붙이면 나머지가 사라진다', async () => {
    const { items } = await boss();
    const a = items.find((s) => s.studentId === A)!;
    const b = items.find((s) => s.studentId === B)!;
    expect(a.cases.some((c) => c.id === SHARED)).toBe(true);
    expect(b.cases.some((c) => c.id === SHARED)).toBe(true);
    expect(b.caseCount).toBe(1);
  });

  it('학생 줄은 이름 차례다 — 원문 컷의 왼쪽 줄과 같다', async () => {
    const names = (await boss()).items.map((s) => s.name);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, 'ko')));
  });

  /* ── ④ 잠긴 내용 ─────────────────────────────────────────────────── */

  it('내용이 잠긴 건은 항목 줄이 비지만 **숫자는 산다** — 화면이 세면 「0/0」이 된다', async () => {
    await q.query(
      `INSERT INTO cons_item (cons_id, seq, label, done, done_by, done_at) VALUES
         (${PAY_ONLY},1,'가',true,${OWNER},now()),(${PAY_ONLY},2,'나',false,NULL,NULL)`,
    );
    const c = (await find(stranger, A))!.cases.find((x) => x.id === PAY_ONLY)!;
    expect(c.items).toEqual([]);        // 수납만 공개 — 내용은 안 내려간다
    expect(c.itemsDone).toBe(1);        // 그래도 「1/2」는 말해 준다
    expect(c.itemsTotal).toBe(2);
    expect(c.amount).toBe(300000);      // 원문 §28 규칙과 같은 자리 — 금액은 보인다
  });

  it('금액 권한이 없으면 건별도 학생 합계도 null — 0 원과 「가려짐」을 구분한다 (D-R39)', async () => {
    const { items, canSeeAmounts } = await svc().students(OWNER, false, true);
    const a = items.find((s) => s.studentId === A)!;
    expect(canSeeAmounts).toBe(false);
    expect(a.amount).toBeNull();
    expect(a.paid).toBeNull();
    expect(a.cases[0].amount).toBeNull();
    expect(a.cases[0].paid).toBeNull();
    // 세는 것은 금액과 무관하다 — 항목·회차는 그대로 내려간다
    expect(a.cases.some((c) => c.itemsTotal > 0)).toBe(true);
  });
});
