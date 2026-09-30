/** @file-guide
 * 목적: family-db.spec.ts — A-13 형제 묶음(보호자 연락처 한 단계) · 회계 형제 합산 보기 (test)
 * 책임/재사용: 기존 대상 함수(lib/family.familyLinks · AccountingService.all 의 families)를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * A-13 「형제 둘이 같이 등록 — 학부모 연락처로 묶여 보인다」 (대표 답변 2026-09-30 「묶음 표시 + 합산 보기」 · 청구 모델은 그대로).
 *
 * 증명하는 것 —
 *   ① 사용 중인 보호자의 휴대폰이 같으면 형제다 — 양쪽에서 서로를 본다 · 「누구로 묶였나」(via)는 이 학생 쪽 보호자 이름.
 *   ② 이메일은 대소문자 무관하게 같으면 형제다.
 *   ③ 사용 중지한 보호자는 잇지 않는다 · 연락처가 다른 학생은 묶이지 않는다.
 *   ④ 한 단계만 본다 — A↔B(전화) · B↔C(메일)이면 A 의 형제는 B 뿐이다(C 까지 번지지 않는다).
 *   ⑤ 회계 합산 보기 — 같은 달 · 이어진 학생의 청구서가 한 묶음 · 합계는 서버가 낸다 · 다른 달 · 취소(void)는 섞이지 않는다.
 *   ⑥ 금액을 못 보는 사람에게는 묶음은 서되 합계가 null 이다(D-R39 — 가린 금액을 더해 드러내지 않는다).
 *
 * ⚠ 스크래치 DB 한 트랜잭션 안에서 만들고 끝에 되돌린다 — 표를 비우지 않는다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { familyLinks } from '../src/lib/family';
import { AccountingService } from '../src/modules/accounting/accounting.service';
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

d('A-13 형제 묶음 · 합산 보기', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let staffId = 0;
  const run = (sql: string, p: unknown[]) => q.query(sql, p) as Promise<unknown[]>;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));

  const student = async (name: string, grade = '5'): Promise<number> => {
    const [r] = (await q.query(`INSERT INTO stu (name, grade) VALUES ($1,$2) RETURNING id`, [name, grade])) as Array<{ id: string }>;
    return Number(r!.id);
  };
  const guardian = async (studentId: number, name: string, c: { phone?: string; email?: string; active?: boolean }) => {
    const active = c.active ?? true;
    await q.query(
      `INSERT INTO guardian (student_id, name, relation, email, phone, receive_email, receive_sms, is_primary, active, created_by)
       VALUES ($1,$2,'어머니',$3,$4,false,false,$5,$6,$7)`,
      [studentId, name, c.email ?? null, c.phone ?? null, active, active, staffId],
    );
  };
  const invoice = async (studentId: number, month: string, amount: number, state = 'sent'): Promise<number> => {
    const [r] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state) VALUES ($1,$2,'tuition','형제 수업료',$3,$4) RETURNING id`,
      [studentId, month, amount, state],
    )) as Array<{ id: string }>;
    return Number(r!.id);
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const [s] = (await q.query(
      `INSERT INTO staff (name, email, role, password_hash, active) VALUES ('형제 담당','family-spec@t.kr','manager','x',true) RETURNING id`,
    )) as Array<{ id: string }>;
    staffId = Number(s!.id);
  });
  afterEach(async () => { await q.rollbackTransaction(); await q.release(); });
  afterAll(async () => { await ds?.destroy(); });

  it('① 같은 휴대폰 → 양쪽에서 서로를 형제로 본다 · via 는 이 학생 쪽 보호자', async () => {
    const a = await student('형제가');
    const b = await student('형제나');
    await guardian(a, '가엄마', { phone: '01077770001' });
    await guardian(b, '나엄마', { phone: '01077770001' });
    const links = await familyLinks(run, [a, b]);
    expect(links.get(a)).toEqual([{ studentId: b, studentName: '형제나', grade: '5', via: '가엄마' }]);
    expect(links.get(b)).toEqual([{ studentId: a, studentName: '형제가', grade: '5', via: '나엄마' }]);
  });

  it('② 이메일은 대소문자 무관 · ③ 사용 중지 보호자와 다른 연락처는 잇지 않는다', async () => {
    const c = await student('메일다');
    const e = await student('메일라');
    const off = await student('중지마');
    const other = await student('남남바');
    await guardian(c, '다엄마', { email: 'Family.Mom@T.kr' });
    await guardian(e, '라엄마', { email: 'family.mom@t.kr' });
    await guardian(off, '마엄마', { email: 'family.mom@t.kr', active: false });
    await guardian(other, '바엄마', { phone: '01077770099' });
    const links = await familyLinks(run, [c, e, off, other]);
    expect(links.get(c)?.map((l) => l.studentId)).toEqual([e]);
    expect(links.get(e)?.map((l) => l.studentId)).toEqual([c]);
    expect(links.has(off)).toBe(false);
    expect(links.has(other)).toBe(false);
  });

  it('④ 한 단계만 — A↔B(전화) · B↔C(메일)이면 A 의 형제는 B 뿐', async () => {
    const a = await student('단계가');
    const b = await student('단계나');
    const c = await student('단계다');
    await guardian(a, '가보호', { phone: '01077770002' });
    await guardian(b, '나보호', { phone: '01077770002', email: 'step@t.kr' });
    await guardian(c, '다보호', { email: 'STEP@t.kr' });
    const links = await familyLinks(run, [a, b, c]);
    expect(links.get(a)?.map((l) => l.studentId)).toEqual([b]);
    expect(links.get(b)?.map((l) => l.studentId).sort((x, y) => x - y)).toEqual([a, c].sort((x, y) => x - y));
    expect(links.get(c)?.map((l) => l.studentId)).toEqual([b]);
  });

  it('⑤ 합산 보기 — 같은 달 · 이어진 학생만 한 묶음 · 합계는 서버 · 다른 달 · 취소는 섞이지 않는다', async () => {
    const a = await student('합산가');
    const b = await student('합산나');
    const c = await student('합산다');
    await guardian(a, '합가엄마', { phone: '01077770003' });
    await guardian(b, '합나엄마', { phone: '01077770003', email: 'sum@t.kr' });
    await guardian(c, '합다엄마', { email: 'SUM@t.kr' });
    const ia = await invoice(a, '2026-08', 300_000);
    const ib = await invoice(b, '2026-08', 250_000);
    const ic = await invoice(c, '2026-08', 100_000);
    await invoice(a, '2026-07', 300_000);          // 다른 달 — 형제가 그 달 청구서가 없으면 묶음이 서지 않는다
    await invoice(b, '2026-08', 999_000, 'void');  // 취소 — 합계에 들지 않는다

    const dto = await svc().all(true);
    const mine = dto.families.filter((f) => f.students.some((s) => [a, b, c].includes(s.studentId)));
    expect(mine).toHaveLength(1);
    const [fam] = mine;
    expect(fam!.yearMonth).toBe('2026-08');
    // 형 · 동생 · 막내가 연락처 하나를 두 줄로 나눠 가져도 한 묶음이다(가장 작은 번호가 대표)
    expect(fam!.students.map((s) => s.studentId).sort((x, y) => x - y)).toEqual([a, b, c].sort((x, y) => x - y));
    expect(fam!.invoiceIds).toEqual([ia, ib, ic].sort((x, y) => x - y));
    expect(fam!.amount).toBe(650_000);
    expect(fam!.paidAmount).toBe(0);
  });

  it('⑥ 금액을 못 보면 묶음은 서되 합계는 null', async () => {
    const a = await student('가림가');
    const b = await student('가림나');
    await guardian(a, '림가엄마', { phone: '01077770004' });
    await guardian(b, '림나엄마', { phone: '01077770004' });
    await invoice(a, '2026-08', 300_000);
    await invoice(b, '2026-08', 250_000);
    const dto = await svc().all(false);
    const [fam] = dto.families.filter((f) => f.students.some((s) => s.studentId === a));
    expect(fam).toBeDefined();
    expect(fam!.students).toHaveLength(2);
    expect(fam!.amount).toBeNull();
    expect(fam!.paidAmount).toBeNull();
  });
});
