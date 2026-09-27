/** @file-guide
 * 목적: exec-withdraw-owner-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §69 · §73 대표 보고 — W11 운영(O) · N-97 회수 · 결재 결과 알림 · N-81 영역 담당 · 7-3 ② 옛 한 줄 칸.
 *
 * 증명하는 것 —
 *   ① 회수는 **올린 사람만** · 올라간 보고만 — 메모는 두고 서명(올린 사람 · 시각)은 지운다 · 감사 줄(RPT · withdraw) 한 줄.
 *   ② 승인 · 반려는 **올린 사람에게 알린다** — 결재자가 곧 올린 사람이면 보내지 않는다 · 막힌 결재는 알림 0줄.
 *   ③ 영역 담당은 처음엔 비어 있고, 대표 판정으로 정하고 비운다 — 감사 줄(EXEC_AREA · owner) · 그만둔 사람은 못 고른다.
 *   ④ 보고 줄에 옛 한 줄 칸(memo)이 없다 — 「숫자만으로는 모를 것」은 여섯 칸(memos)이 전부다.
 */
import { ForbiddenException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { ExecService } from '../src/modules/exec/exec.service';
import { ExecController } from '../src/modules/exec/exec.controller';
import { BoardService } from '../src/modules/board/board.service';
import { EXEC_AREA_KEYS } from '../src/lib/exec-areas';
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

const W1 = 991;
const CEO = 992;
const W2 = 993;
const GONE = 994;
const DAY = '2026-08-21';

describe('영역 담당 지정 경로 — 대표 판정 한 곳 (N-81)', () => {
  it('일정 권한을 사람별로 받은 강사도 담당은 못 정한다 — 서비스를 부르지 않는다', () => {
    const setAreaOwner = jest.fn();
    const ctl = new ExecController({ setAreaOwner } as unknown as ExecService);
    expect(() => ctl.setAreaOwner(
      { id: 1, name: '강사', role: 'teacher', perms: { canCrudAll: true } }, { key: 'ops' }, { staffId: 2 },
    )).toThrow(ForbiddenException);
    expect(setAreaOwner).not.toHaveBeenCalled();
    void ctl.setAreaOwner({ id: 1, name: '매니저', role: 'manager' }, { key: 'ops' }, { staffId: 2 });
    expect(setAreaOwner).toHaveBeenCalledWith('ops', 2, 1);
  });
});

d('§69 · §73 회수 · 결재 알림 · 영역 담당 (W11 O · N-97 · N-81 · 7-3 ②)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => {
    const repo = q.manager.getRepository(Lead);
    return new ExecService(repo, new BoardService(repo));
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    for (const t of ['rpt', 'noti', 'exec_area_owner']) await q.query(`DELETE FROM ${t}`);
    await q.query(`DELETE FROM log WHERE entity IN ('RPT','rpt','EXEC_AREA')`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title,active) VALUES
         (${W1},'올린이O7','o7e-w1@t.kr','manager','매니저',true),
         (${CEO},'대표O7e','o7e-ceo@t.kr','ceo','대표',true),
         (${W2},'다른이O7','o7e-w2@t.kr','manager',NULL,true),
         (${GONE},'퇴사O7e','o7e-gone@t.kr','manager',NULL,false)
       ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const sent = async (by = W1): Promise<number> => {
    await svc().saveMemo({ rptType: 'day', onDate: DAY, memos: [{ key: 'money', memo: '카드 결제 2건 내일 확인' }] }, by);
    return (await svc().submit({ rptType: 'day', onDate: DAY }, by)).id;
  };
  const report = async (viewerId: number) =>
    (await svc().range(DAY, DAY, true, { id: viewerId, canApprove: true })).reports.find((r) => r.rptType === 'day')!;
  const notis = () => q.query(
    `SELECT to_id::int AS to_id, from_id::int AS from_id, body, link, category::text AS category, title FROM noti ORDER BY id`,
  ) as Promise<Array<{ to_id: number; from_id: number; body: string; link: string; category: string; title: string }>>;

  /* ── ① 회수 ───────────────────────────────────────────────────────── */

  it('올린 사람만 회수한다 — 메모는 남고 서명은 지워지며 감사 줄이 한 줄 · 다시 올릴 수 있다', async () => {
    const id = await sent();
    expect((await report(W1)).canWithdraw).toBe(true);
    expect((await report(W2)).canWithdraw).toBe(false);

    await expect(svc().withdraw(id, W2)).rejects.toMatchObject({ response: { code: 'RPT_NOT_SUBMITTER' } });
    const out = await svc().withdraw(id, W1);
    expect(out).toMatchObject({ id, state: 'draft', filled: 1, sentByName: null });
    const [row] = (await q.query(`SELECT state, sent_at, sent_by, memo FROM rpt WHERE id = $1`, [id])) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ state: 'draft', sent_at: null, sent_by: null, memo: { money: '카드 결제 2건 내일 확인' } });

    const logs = (await q.query(
      `SELECT actor_id::int AS actor, before, after FROM log WHERE entity = 'RPT' AND action = 'withdraw' AND entity_id = $1`, [id],
    )) as Array<{ actor: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
    expect(logs).toHaveLength(1);
    expect(logs[0].actor).toBe(W1);
    expect(logs[0].before).toMatchObject({ state: 'sent', sentBy: W1, sentAt: expect.stringMatching(/\+09:00$/) });
    expect(logs[0].after).toEqual({ state: 'draft', sentBy: null, sentAt: null });

    // 두 번째 회수는 막힌다(이미 작성 중) — 감사 줄은 늘지 않는다
    await expect(svc().withdraw(id, W1)).rejects.toMatchObject({ response: { code: 'RPT_NOT_SENT' } });
    const again = (await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'RPT' AND action = 'withdraw'`)) as Array<{ n: number }>;
    expect(again[0].n).toBe(1);
    // 고쳐서 다시 올린다 — 서명이 새로 선다
    expect((await svc().submit({ rptType: 'day', onDate: DAY }, W1)).state).toBe('sent');
  });

  it('결재가 끝난 보고는 회수하지 않는다 — 409 · 줄은 그대로', async () => {
    const id = await sent();
    await svc().review(id, { action: 'ok' }, CEO);
    await expect(svc().withdraw(id, W1)).rejects.toMatchObject({ response: { code: 'RPT_NOT_SENT' } });
    const [row] = (await q.query(`SELECT state FROM rpt WHERE id = $1`, [id])) as Array<{ state: string }>;
    expect(row.state).toBe('ok');
    expect((await report(W1)).canWithdraw).toBe(false);
  });

  /* ── ② 결재 결과 알림 ─────────────────────────────────────────────── */

  it('승인 · 반려는 올린 사람에게 알린다 — 사실만 · 결재 흐름이 쓰는 링크', async () => {
    const id = await sent();
    await q.query(`DELETE FROM noti`);
    await svc().review(id, { action: 'rej', reason: '수치 근거가 없습니다' }, CEO);
    const [rej] = await notis();
    expect(rej).toEqual({
      to_id: W1, from_id: CEO, category: 'request', title: '대표 보고 반려',
      body: `일일 보고가 반려되었습니다 — ${DAY} · 사유: 수치 근거가 없습니다`,
      link: `/exec?view=day&date=${DAY}&rpt=${id}`,
    });

    await svc().submit({ rptType: 'day', onDate: DAY }, W1);
    await q.query(`DELETE FROM noti`);
    await svc().review(id, { action: 'ok' }, CEO);
    expect(await notis()).toEqual([expect.objectContaining({
      to_id: W1, title: '대표 보고 승인', body: `일일 보고가 승인되었습니다 — ${DAY}`,
    })]);
  });

  it('결재자가 곧 올린 사람이면 알리지 않는다 · 막힌 결재는 알림도 감사도 남기지 않는다', async () => {
    const id = await sent(CEO);
    await q.query(`DELETE FROM noti`);
    await svc().review(id, { action: 'ok' }, CEO);
    expect(await notis()).toHaveLength(0);

    await expect(svc().review(id, { action: 'ok' }, W2)).rejects.toMatchObject({ response: { code: 'RPT_NOT_SENT' } });
    expect(await notis()).toHaveLength(0);
    const reviews = (await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'rpt' AND action = 'ok' AND entity_id = $1`, [id])) as Array<{ n: number }>;
    expect(reviews[0].n).toBe(1);
  });

  /* ── ③ 영역 담당 ─────────────────────────────────────────────────── */

  it('영역 담당은 처음엔 비어 있다 — 정하고 비우는 쓰기마다 감사 줄 · 이름은 지어내지 않는다', async () => {
    const first = await svc().range(DAY, DAY, true, { id: CEO, canApprove: true, canSetOwner: true });
    expect(first.areas.map((a) => [a.key, a.ownerId, a.ownerName, a.canSetOwner]))
      .toEqual(EXEC_AREA_KEYS.map((k) => [k, null, null, true]));
    // 보는 사람을 모르면 바꾸는 단추를 닫는다
    expect((await svc().range(DAY, DAY, true)).areas.every((a) => a.canSetOwner === false)).toBe(true);

    expect(await svc().setAreaOwner('ops', W2, CEO)).toEqual({ key: 'ops', ownerId: W2, ownerName: '다른이O7' });
    const set = await svc().range(DAY, DAY, true, { id: W1, canApprove: true });
    expect(set.areas.find((a) => a.key === 'ops')).toMatchObject({ ownerId: W2, ownerName: '다른이O7', canSetOwner: false });

    expect(await svc().setAreaOwner('ops', null, CEO)).toEqual({ key: 'ops', ownerId: null, ownerName: null });
    const logs = (await q.query(
      `SELECT actor_id::int AS actor, entity_id::int AS entity_id, before, after FROM log WHERE entity = 'EXEC_AREA' AND action = 'owner' ORDER BY id`,
    )) as Array<{ actor: number; entity_id: number; before: unknown; after: unknown }>;
    const ops = EXEC_AREA_KEYS.indexOf('ops') + 1;
    expect(logs).toEqual([
      { actor: CEO, entity_id: ops, before: { areaKey: 'ops', staffId: null }, after: { areaKey: 'ops', staffId: W2 } },
      { actor: CEO, entity_id: ops, before: { areaKey: 'ops', staffId: W2 }, after: { areaKey: 'ops', staffId: null } },
    ]);
    const [row] = (await q.query(`SELECT staff_id, set_by::int AS set_by FROM exec_area_owner WHERE area_key = 'ops'`)) as Array<Record<string, unknown>>;
    expect(row).toEqual({ staff_id: null, set_by: CEO });
  });

  it('그만둔 사람은 담당으로 고르지 못한다 — 줄도 감사도 남지 않는다', async () => {
    await expect(svc().setAreaOwner('money', GONE, CEO)).rejects.toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    const [n] = (await q.query(
      `SELECT (SELECT count(*) FROM exec_area_owner)::int AS rows, (SELECT count(*) FROM log WHERE entity = 'EXEC_AREA')::int AS logs`,
    )) as Array<{ rows: number; logs: number }>;
    expect(n).toEqual({ rows: 0, logs: 0 });
  });

  /* ── ④ 옛 한 줄 칸 ─────────────────────────────────────────────── */

  it('보고 줄에 옛 한 줄 칸(memo)이 없다 — 여섯 칸만 내려간다', async () => {
    await sent();
    const r = await report(W1);
    expect(Object.keys(r)).not.toContain('memo');
    expect(r.memos.find((m) => m.key === 'money')!.memo).toBe('카드 결제 2건 내일 확인');
  });
});
