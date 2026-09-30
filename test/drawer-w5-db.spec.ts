/** @file-guide
 * 목적: drawer-w5-db.spec.ts (test) — 서랍 wave 5 잔여 — 변경 요청 겹침 미리보기의 날짜 · §14 승인 대기함의 원천 · §75 강사 요청 줄 · §16 칩 차례
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * g2 대조의 남은 줄 넷을 한 파일에서 잠근다.
 *
 *   ① 옮긴 회차의 변경 요청은 **실제로 놓인 날**의 겹침을 본다 — 규칙이 찍은 날(`on_date`)은
 *      EXC 키일 뿐 달력 날짜가 아니다(C84-b 가 `conflicts()` 에 적어 둔 그 구분). 예전에는 키를
 *      달력 날짜로 넘겨, 다른 날로 옮긴 회차의 요청이 **엉뚱한 날**의 겹침을 보고 있었다.
 *   ② §14 승인 대기함의 원천은 원문 슬라이드 14 의 「데이터: REQ(강사 요청), SER」 이다 —
 *      자료 요청(gpapack)은 강사가 올린 요청이 아니라 §75 「자료 요청 → 실장에게」 줄이다(g2 14-2).
 *   ③ §75 의 강사 요청 줄은 원문 그대로 제목 「강사 요청」 + 회색 부제 요청자다(g2 75-6).
 *   ④ §16 칩 차례는 원문 「작성 독촉 · 재알람 · 리포트 · 요청 처리 · 일정 변경」이다(g2 16-3).
 *
 * DB 가 필요한 것은 한 트랜잭션 안에서 만들고 되돌린다 — 스크래치 DB 에 남는 줄이 없다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { approvalFlowProjection, apFlow, approvalInboxCategory, type ApRow } from '../src/lib/approval';
import { NOTI_CATEGORIES, NOTI_CATEGORY_LABEL } from '../src/lib/noti';
import { TzgSeoulName1763200000000 } from '../src/migrations/1763200000000-tzg-seoul-name';
import { TZGS } from '../src/seed/base';
import { DrawerController } from '../src/modules/drawer/drawer.controller';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import type { ScheduleService } from '../src/modules/schedule/schedule.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

const url = TEST_URL ? assertScratch(TEST_URL) : '';

/** 이 스위트만 쓰는 번호 — 다른 스위트의 시드·픽스처 번호와 겹치지 않게 멀리 둔다 */
const TEACHER = 91851;
const HEAD = 91852;
const SER = 99185101;

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

const row = (over: Partial<ApRow>): ApRow => ({
  kind: 'req', id: 1, title: '시급 변경 요청', sub: '40,000원/시간 → 45,000원/시간',
  byId: TEACHER, byName: 'Sophia', at: '2026-08-21 10:40', state: 'waiting', why: null, go: '/ops',
  reqType: 'wage_change',
  ...over,
});

describe('① 변경 요청 겹침 미리보기 — 실제로 놓인 날을 본다 (DB 독립)', () => {
  const viewer = { id: HEAD, name: '실장', role: 'manager' };

  it('다른 날로 옮긴 회차의 시간 옮기기 요청은 옮겨 간 날의 겹침을 묻는다 — 키(on_date)는 저장에만 쓴다', async () => {
    const svc = {
      // 규칙이 찍은 날은 09-07 인데 그 회차는 09-08 로 옮겨져 있다
      occOf: jest.fn().mockResolvedValue({
        startMin: 540, endMin: 600, teacherId: TEACHER, roomId: null, zaccId: null, date: '2026-09-08',
      }),
      activeChangeTargetExists: jest.fn().mockResolvedValue(true),
      createChangeReq: jest.fn().mockImplementation(async (_byId, _d, preflight: () => Promise<unknown[]>) => {
        const conflicts = await preflight();
        return { id: conflicts.length ? null : 300, conflicts };
      }),
    };
    const sched = { conflicts: jest.fn().mockResolvedValue([]) };
    const controller = new DrawerController(svc as unknown as DrawerService, sched as unknown as ScheduleService);

    await controller.createChangeReq(viewer, {
      reqType: 'time_move', serId: 100, onDate: '2026-09-07', startMin: 600, endMin: 660, reason: '시간 변경',
    });

    expect(sched.conflicts).toHaveBeenCalledWith(expect.objectContaining({
      onDate: '2026-09-08', startMin: 600, endMin: 660, exceptSerId: 100,
    }), undefined);
    // 저장하는 키는 그대로 규칙의 날이다 — 반영(patch)이 EXC 를 그 키로 찾는다
    expect(svc.createChangeReq).toHaveBeenCalledWith(HEAD, expect.objectContaining({ serId: 100, onDate: '2026-09-07' }), expect.any(Function));
  });
});

describe('② §14 승인 대기함의 원천 — 강사 요청과 계산한 누락뿐이다 (DB 독립)', () => {
  it('자료 요청은 「GPA 요청」이 아니다 — 분류는 기타, §14 목록에는 들지 않는다', () => {
    expect(approvalInboxCategory(row({ kind: 'gpapack' }))).toBe('other');
    const flow = apFlow([
      row({ id: 1 }),
      row({ kind: 'gpapack', id: 2, title: '시험 대비 자료 요청', sub: '기한 10-02' }),
    ], HEAD, true);
    expect(flow.inbox.map((r) => r.kind)).toEqual(['req']);
    expect(flow.inboxCount).toBe(1);
    // 칩은 어휘다 — 0 이어도 선다. GPA 요청 칩도 그대로 있다
    expect(flow.categories.find((c) => c.key === 'gpa_request')).toEqual({ key: 'gpa_request', label: 'GPA 요청', count: 0 });
    expect(flow.categories.find((c) => c.key === 'other')?.count).toBe(0);
    // §75 결재 흐름은 자료 요청을 그대로 센다 — 「자료 요청 → 실장에게」
    expect(flow.waiting.map((r) => r.kind)).toContain('gpapack');
  });
});

describe('③ §75 강사 요청 줄 — 제목 「강사 요청」 + 회색 부제 요청자 (DB 독립)', () => {
  it('강사 요청은 원문 줄 모양이고, 다른 갈래의 제목·부제는 그대로다', () => {
    const p = approvalFlowProjection([
      row({ id: 1 }),
      row({ kind: 'plan', id: 2, title: '9월 신규 상담 유입 30% 늘리기', sub: '홍지승 · 마감 08-25', byId: 7, byName: '홍지승' }),
    ], HEAD, 'all');
    const req = p.waiting.find((r) => r.kind === 'req')!;
    expect(req.title).toBe('강사 요청');
    expect(req.sub).toBe('Sophia');
    expect(req.byName).toBe('Sophia');
    const plan = p.waiting.find((r) => r.kind === 'plan')!;
    expect(plan.title).toBe('9월 신규 상담 유입 30% 늘리기');
    expect(plan.sub).toBe('홍지승 · 마감 08-25');
  });

  it('요청자를 모르는 옛 줄은 부제를 비운다 — 이름을 지어내지 않는다', () => {
    const p = approvalFlowProjection([row({ id: 1, byId: 99, byName: null })], HEAD, 'all');
    expect(p.waiting[0].title).toBe('강사 요청');
    expect(p.waiting[0].sub).toBeNull();
  });
});

describe('④ §16 칩 차례 — 원문 그대로 (DB 독립)', () => {
  it('작성 독촉 · 재알람 · 리포트 · 요청 처리 · 일정 변경 · 시스템', () => {
    expect(NOTI_CATEGORIES.map((k) => NOTI_CATEGORY_LABEL[k])).toEqual([
      '작성 독촉', '재알람', '리포트', '요청 처리', '일정 변경', '시스템',
    ]);
  });
});

d('① · ② 서랍 응답 — 스크래치 DB', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => new DrawerService(q.manager.getRepository(Lead));

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id, name, email, role) VALUES
         ($1, 'Sophia', 'w5-teacher@t.kr', 'teacher'),
         ($2, '실장 테스트', 'w5-head@t.kr', 'manager')
       ON CONFLICT (id) DO NOTHING`,
      [TEACHER, HEAD],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('occOf 는 규칙의 날(키)로 찾고, 그 회차가 실제로 놓인 달력 날짜를 함께 준다', async () => {
    // 투영 행만 있으면 된다(`ser_occ` 는 규칙 표를 참조하지 않는 투영이다).
    // 키는 10-05, 실제로는 10-06 10:00–11:00 (KST) 로 옮겨져 있다
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, span)
       VALUES ($1, '2026-10-05', $2, tstzrange('2026-10-06 10:00+09', '2026-10-06 11:00+09', '[)'))`,
      [SER, TEACHER],
    );
    const occ = await svc().occOf(SER, '2026-10-05');
    expect(occ).toEqual(expect.objectContaining({ startMin: 600, endMin: 660, teacherId: TEACHER, date: '2026-10-06' }));
    expect(await svc().occOf(SER, '2026-10-06')).toBeNull();
  });

  it('시간대 그룹 이름 「서울」 — 옛 이름인 Asia/Seoul 행만 고치고, 따로 바꿔 둔 이름은 덮지 않는다 (17-1)', async () => {
    const [old] = (await q.query(
      `INSERT INTO tzg (name, tz) VALUES ('한국 (KST)', 'Asia/Seoul') RETURNING id`,
    )) as Array<{ id: string }>;
    const [custom] = (await q.query(
      `INSERT INTO tzg (name, tz) VALUES ('본사', 'Asia/Seoul') RETURNING id`,
    )) as Array<{ id: string }>;
    const nameOf = async (id: string) =>
      ((await q.query(`SELECT name FROM tzg WHERE id = $1`, [id])) as Array<{ name: string }>)[0].name;

    const m = new TzgSeoulName1763200000000();
    await m.up(q);
    expect(await nameOf(old.id)).toBe('서울');
    expect(await nameOf(custom.id)).toBe('본사');
    await m.down(q);
    expect(await nameOf(old.id)).toBe('한국 (KST)');
    expect(await nameOf(custom.id)).toBe('본사');
    // 시드도 같은 낱말이다 — 새 DB 와 옛 DB 가 같은 이름을 갖는다
    expect(TZGS.find((g) => g.tz === 'Asia/Seoul')?.name).toBe('서울');
  });

  it('자료 요청은 §14 목록에 들지 않고 §75 결재 흐름에는 그대로 선다', async () => {
    const [pack] = (await q.query(
      `INSERT INTO gpapack (pack_type, title, effective_on, coordinator_id, created_by)
       VALUES ('exam', '2학기 중간', '2026-10-02', $2, $1) RETURNING id`,
      [TEACHER, HEAD],
    )) as Array<{ id: string }>;
    const [req] = (await q.query(
      `INSERT INTO req (staff_id, req_type, payload) VALUES ($1, 'wage_change', $2::jsonb) RETURNING id`,
      [TEACHER, JSON.stringify({ from: 40000, to: 45000 })],
    )) as Array<{ id: string }>;
    const out = await svc().all(HEAD, true, true, false, 'all');
    const mine = out.approvals.inbox.filter((r) => r.byId === TEACHER);
    expect(mine.some((r) => r.kind === 'gpapack')).toBe(false);
    expect(mine.some((r) => r.kind === 'req' && r.id === Number(req.id))).toBe(true);
    // 레일 배지는 목록과 같은 배열에서 센다
    expect(out.approvals.inboxCount).toBe(out.approvals.inbox.length);

    const flowPack = out.approvalFlow.waiting.find((r) => r.kind === 'gpapack' && r.id === Number(pack.id))!;
    expect(flowPack.title).toBe('시험 대비 자료 요청 · 2학기 중간');
    const flowReq = out.approvalFlow.waiting.find((r) => r.kind === 'req' && r.id === Number(req.id))!;
    expect(flowReq.title).toBe('강사 요청');
    expect(flowReq.sub).toBe('Sophia');
  });
});
