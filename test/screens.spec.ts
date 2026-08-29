/**
 * 탭 04 · 05 · 06 · 07 · 11 의 API — **화면이 실제로 데이터를 받는가**.
 *
 * 내비게이션에는 있는데 문이 없던 다섯 자리다. 여기서 확인하는 것은 셋이다.
 *   ① 시드가 든 진짜 Postgres 에서 **행이 내려온다** (빈 화면이 아니다)
 *   ② 강사에게는 **금액이 안 내려온다** — 화면이 감추는 게 아니라 응답에 없다 (D-R39)
 *   ③ 현황판·대표 보고는 **저장하지 않는다** — 매번 다른 computedAt 이 온다 (D-R4)
 *
 * DATABASE_URL 이 없으면 건너뛴다. 이 파일은 **읽기만** 한다 (test/db.ts 참고).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(40_000);

d('탭 04·05·06·07·11 — 화면이 받는 것', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 'screens-test-1234';
  const PEOPLE = [
    { id: 911, name: '강사스크린', email: 'scr-teacher@t.kr', role: 'teacher' },
    { id: 912, name: '매니저스크린', email: 'scr-manager@t.kr', role: 'manager' },
    { id: 913, name: '대표스크린', email: 'scr-ceo@t.kr', role: 'ceo' },
  ];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    ds = app.get(DataSource);
    const hash = await bcrypt.hash(PW, 4);
    await ds.query('DELETE FROM staff WHERE id BETWEEN 911 AND 913');
    for (const p of PEOPLE) {
      await ds.query(
        `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES ($1,$2,$3,$4,$5,true)`,
        [p.id, p.name, p.email, p.role, hash],
      );
    }
  });

  afterAll(async () => {
    await ds?.query('DELETE FROM staff WHERE id BETWEEN 911 AND 913');
    await app?.close();
  });

  const CEO = 'scr-ceo@t.kr';
  const TEACHER = 'scr-teacher@t.kr';
  const MANAGER = 'scr-manager@t.kr';

  /** 토큰은 한 번만 받아 둔다 — 매 호출마다 로그인하면 테스트가 느려지기만 한다. */
  const tokens = new Map<string, string>();
  beforeAll(async () => {
    for (const email of [CEO, TEACHER, MANAGER]) {
      const res = await request(app.getHttpServer())
        .post('/auth/login').send({ email, password: PW }).expect(201);
      tokens.set(email, res.body.accessToken as string);
    }
  });

  /** supertest 의 Test 를 그대로 돌려준다 — .expect() 를 이어 쓸 수 있게. */
  const get = (path: string, email: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${tokens.get(email)!}`);

  /* ── ① 빈 화면이 아니다 ─────────────────────────────────────────── */

  it('교재 — 강사도 본다. 자기 수업에 무엇을 쓰는지 알아야 한다', async () => {
    const r = await get('/books', TEACHER).expect(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(Object.keys(r.body.bySub).length).toBeGreaterThan(0);
    // 코드가 카드에 그대로 보이는 값이라 비어 있으면 안 된다
    r.body.items.forEach((b: { code: string }) => expect(b.code).toBeTruthy());
  });

  it('컨설팅 — 건과 회차 기록이 같이 온다', async () => {
    const r = await get('/consulting', CEO).expect(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.some((c: { sessionsLog: unknown[] }) => c.sessionsLog.length > 0)).toBe(true);
  });

  it('안내 — 한 번(GUIDE)과 매번(PNOTI)이 나뉘어 온다', async () => {
    const r = await get('/guides', MANAGER).expect(200);
    expect(r.body.guides.length).toBeGreaterThan(0);
    expect(r.body.perLesson.length).toBeGreaterThan(0);
    // 섞이면 「지난번에 보냈으니 됐다」가 된다 (D-R5)
    expect(r.body.guides).not.toBe(r.body.perLesson);
  });

  it('현황판 — 회차마다 네 마크가 온다', async () => {
    const r = await get('/board?from=2026-08-01&to=2026-09-30', MANAGER).expect(200);
    expect(r.body.rows.length).toBeGreaterThan(0);
    const row = r.body.rows[0];
    expect(row.marks.map((m: { key: string }) => m.key).sort()).toEqual(['book', 'guide', 'report', 'zoom']);
    // 오프라인 수업의 줌은 판정하지 않는다 — 해당 없음이다
    const offline = r.body.rows.find((x: { mode: string }) => x.mode === 'offline');
    if (offline) {
      expect(offline.marks.find((m: { key: string }) => m.key === 'zoom').na).toBe(true);
    }
  });

  it('대표 보고 — 숫자 칸과 제출된 보고가 온다', async () => {
    const r = await get('/exec?from=2026-08-01&to=2026-08-31', CEO).expect(200);
    expect(r.body.stats.length).toBeGreaterThan(0);
    expect(r.body.stats.find((s: { key: string }) => s.key === 'lessons').value).toBeGreaterThan(0);
  });

  /* ── ② 금액은 응답에서 뺀다 (D-R39) ──────────────────────────────── */

  it('컨설팅 금액 — 대표는 보고 매니저는 못 본다. 화면이 아니라 응답에서 없다', async () => {
    const ceo = await get('/consulting', CEO).expect(200);
    const mgr = await get('/consulting', MANAGER).expect(200);

    expect(ceo.body.canSeeAmounts).toBe(true);
    expect(mgr.body.canSeeAmounts).toBe(false);

    expect(ceo.body.items.some((c: { amount: number | null }) => c.amount !== null)).toBe(true);
    // share 는 금액이 아니라 **공개 범위**다 (한때 배분율로 착각해 null 로 가리고 있었다).
    // 가려야 하는 것은 amount 하나이고, share 는 화면이 「왜 안 열리는지」 설명하는 데 쓴다.
    mgr.body.items.forEach((c: { amount: number | null; share: string }) => {
      expect(c.amount).toBeNull();
      expect(['all', 'money_only', 'picked', 'private']).toContain(c.share);
    });
  });

  it('대표 보고의 돈 칸 — 대표가 아니면 값이 없다', async () => {
    const ceo = await get('/exec?from=2026-08-01&to=2026-08-31', CEO).expect(200);
    const mgr = await get('/exec?from=2026-08-01&to=2026-08-31', MANAGER).expect(200);

    const money = (b: { stats: Array<{ money: boolean; value: number | null }> }) =>
      b.stats.filter((s) => s.money);

    expect(money(ceo.body).some((s) => s.value !== null)).toBe(true);
    money(mgr.body).forEach((s) => expect(s.value).toBeNull());
  });

  it('컨설팅·대표 보고는 강사가 아예 못 연다', async () => {
    await get('/consulting', TEACHER).expect(403);
    await get('/exec?from=2026-08-01&to=2026-08-31', TEACHER).expect(403);
  });

  it('안내와 현황판은 강사가 열되 자기 것만 본다', async () => {
    const g = await get('/guides', TEACHER).expect(200);
    expect(g.body.scopedTeacherId).toBe(911);

    const b = await get('/board?from=2026-08-01&to=2026-09-30', TEACHER).expect(200);
    // 911 은 시드에 수업이 없는 사람이라 0건이어야 한다 — 남의 수업이 새어 나오면 안 된다
    expect(b.body.rows.length).toBe(0);
  });

  /* ── ②-a 컨설팅 공개 범위 — 권한의 두 번째 층 (DEV-SPEC §4.4) ────
     역할 권한과 **독립**이다. 매니저라도 전체 비공개 건은 담당이나 열람권이 있어야 본다.
     화면에서 숨기는 것으로는 안 된다 — 목록에서 아예 빠져야 한다. */

  it('전체 비공개(private) 건은 열람권이 없으면 목록에서 사라진다', async () => {
    // 대표(canHide) 는 본다
    const ceo = await get('/consulting', CEO).expect(200);
    expect(ceo.body.items.some((c: { share: string }) => c.share === 'private')).toBe(true);

    // 강사는 탭 자체가 안 열린다 — 두 층 중 첫 층에서 막힌다
    await get('/consulting', TEACHER).expect(403);
  });

  it('내용이 안 열리는 건은 회차 기록을 아예 안 내려보낸다', async () => {
    const ceo = await get('/consulting', CEO).expect(200);
    ceo.body.items.forEach((c: { canOpen: boolean; sessionsLog: unknown[] }) => {
      if (!c.canOpen) expect(c.sessionsLog).toHaveLength(0);
    });
  });

  it('공개 범위가 실제로 섞여 있다 — 한 종류뿐이면 이 층이 한 번도 안 돈다', async () => {
    const ceo = await get('/consulting', CEO).expect(200);
    const shares = new Set(ceo.body.items.map((c: { share: string }) => c.share));
    expect(shares.size).toBeGreaterThan(1);
  });

  /* ── ②-b 「썼다」가 실제로 켜지는가 ────────────────────────────────
     한때 이 값이 **항상 false** 였다. DB 는 wait·ok·rej 를 쓰는데 규칙은
     submitted·approved·rejected 를 봤고, 겹치는 값이 하나도 없었다.
     캘린더가 전부 「안 씀」으로 칠해도 아무도 못 알아채는 종류의 오류다. */

  it('캘린더 — 쓴 수업이 쓴 것으로 내려온다', async () => {
    const r = await get('/schedule/occurrences?from=2026-08-01&to=2026-08-31', MANAGER).expect(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    const written = r.body.items.filter((o: { written: boolean }) => o.written);
    expect(written.length).toBeGreaterThan(0);
    // 상태와 written 이 서로 어긋나지 않아야 한다
    // 내려오는 상태는 DB 어휘 그대로다 — 여기서 어휘가 바뀌면 화면이 색을 잘못 칠한다
    written.forEach((o: { repState: string }) =>
      expect(['wait', 'ok', 'rej']).toContain(o.repState));
    // 반대쪽도 본다 — 안 쓴 것이 written 으로 새어 나오면 정산이 부풀어 오른다
    r.body.items
      .filter((o: { written: boolean }) => !o.written)
      .forEach((o: { repState: string }) => expect(['na', 'plan', 'none', 'draft']).toContain(o.repState));
  });

  it('§47 독촉 — 밀린 리포트가 실제로 잡힌다', async () => {
    const r = await get('/reports/unwritten', MANAGER).expect(200);
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.items.length).toBe(r.body.total);
    expect(r.body.byTeacher.length).toBeGreaterThan(0);
    // 밀린 것으로 잡힌 줄은 전부 「안 썼다」여야 한다
    r.body.items.forEach((it: { written: boolean }) => expect(it.written).toBe(false));
  });

  /* ── ③ 저장하지 않는다 (D-R4) ────────────────────────────────────── */

  it('현황판·대표 보고는 저장하지 않는다 — 부를 때마다 다시 센 값이 온다', async () => {
    const a = await get('/board?from=2026-08-01&to=2026-08-31', MANAGER).expect(200);
    await new Promise((r) => setTimeout(r, 1100));
    const b = await get('/board?from=2026-08-01&to=2026-08-31', MANAGER).expect(200);
    expect(a.body.computedAt).not.toBe(b.body.computedAt);

    const e = await get('/exec?from=2026-08-01&to=2026-08-31', CEO).expect(200);
    expect(e.body.computedAt).toBeTruthy();
  });
});
