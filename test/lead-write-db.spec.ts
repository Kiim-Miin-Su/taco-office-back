/** @file-guide
 * 목적: lead-write-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
import { makeOpsService } from './ops-svc';
import { todayKst, addDays } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

/**
 * C90 — 「+ 신규 문의」 · 단계 이동 · 접촉 원장 (N-45 · N-44 · 테스트 시나리오 A-01 · A-02 · A-03 · K-108).
 * 이 스위트 전용 staff 52·53 을 쓴다 — 시드 번호를 빌리면 시드가 바뀔 때 조용히 깨진다(C74).
 */
d('C90 상담 입구 — 신규 문의 · 단계 이동 · 접촉 원장 · §71 퍼널', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const TODAY = todayKst();

  const svc = () => makeOpsService(q.manager.getRepository(Lead));
  const exec = () => { const repo = q.manager.getRepository(Lead); return new ExecService(repo, new BoardService(repo)); };

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
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (52,'접수자','lead52@t.kr','manager'), (53,'상담 담당','lead53@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    await q.query(`UPDATE staff SET active = true WHERE id IN (52,53)`);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('A-01 카카오채널 신규 문의 — 유입은 1차 상담이고 도달 기록·첫 접촉(어떻게 = 카카오톡)·LOG 가 함께 선다', async () => {
    const out = await svc().createLead(52, { name: '  민지수 ', school: '역삼중', source: 'kakao', ownerId: 53, note: ' SAT 여름 특강 문의 · 어머니 010-xxxx ' });
    expect(out).toMatchObject({
      name: '민지수', school: '역삼중', stage: 'first', ownerId: 53, ownerName: '상담 담당',
      source: 'kakao', sourceLabel: '카카오채널', lastTouchAt: expect.any(String), nextOn: null, nextLabel: null,
    });
    // 낱말·전이표는 서버 (D-R18) — 1차에서 갈 수 있는 곳 셋
    expect(out.nextStages).toEqual([{ key: 'wait2nd', label: '2차 대기' }, { key: 'second', label: '2차 상담' }, { key: 'hold', label: '보류' }]);
    expect(out.touches).toEqual([expect.objectContaining({ kind: 'kakao', kindLabel: '카카오톡', note: 'SAT 여름 특강 문의 · 어머니 010-xxxx', byId: 52, byName: '접수자', nextOn: null })]);
    const logs = await q.query(`SELECT stage, by_id FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [out.id]);
    expect(logs).toEqual([expect.objectContaining({ stage: 'first' })]);
    expect(Number(logs[0].by_id)).toBe(52);
    const [log] = await q.query(`SELECT action, after FROM log WHERE entity = 'LEAD' AND entity_id = $1`, [out.id]);
    expect(log).toMatchObject({ action: 'create', after: expect.objectContaining({ source: 'kakao', ownerId: 53 }) });
    // 「경로 없음」이 아니다 — GET /ops 머리의 칩 줄에 카카오채널로 선다
    const all = await svc().all(52, false, false);
    expect(all.intakeHead.sources.find((s) => s.key === 'kakao')!.count).toBeGreaterThanOrEqual(1);
    expect(all.intakeHead.funnelSince).toBe(TODAY);
  });

  it('첫 접촉 한 줄이 없으면 접촉 원장은 비고, 유입 경로 밖의 값·없는 담당은 거절한다', async () => {
    const out = await svc().createLead(52, { name: '박도윤', source: 'walkin' });
    expect(out.touches).toEqual([]);
    expect(out.ownerId).toBeNull();
    await expect(svc().createLead(52, { name: '박도윤', source: 'naver' })).rejects.toMatchObject({ response: { code: 'LEAD_SOURCE_INVALID' } });
    await expect(svc().createLead(52, { name: '   ', source: 'phone' })).rejects.toMatchObject({ response: { code: 'LEAD_NAME_REQUIRED' } });
    await expect(svc().createLead(52, { name: '박도윤', source: 'phone', ownerId: 999999 })).rejects.toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    // 표가 마지막에 막는다 — 서비스를 건너뛴 값도 CHECK 가 거절한다 (막힌 문장마다 SAVEPOINT 로 트랜잭션을 살린다)
    const rejected = async (sql: string, params: unknown[], constraint: string) => {
      await q.query('SAVEPOINT chk');
      await expect(q.query(sql, params)).rejects.toMatchObject({ constraint });
      await q.query('ROLLBACK TO SAVEPOINT chk');
    };
    await rejected(`INSERT INTO lead (name, stage, source) VALUES ('x','first','naver')`, [], 'lead_source_words');
    await rejected(`INSERT INTO lead_touch (lead_id, kind, note) VALUES ($1,'fax','x')`, [out.id], 'lead_touch_kind_words');
    await rejected(`INSERT INTO lead_touch (lead_id, kind, note) VALUES ($1,'memo','   ')`, [out.id], 'lead_touch_note_present');
  });

  it('A-02 전화 문의 → 상담 예약 → 2차 대기 — 전이표대로만 옮기고 같은 트랜잭션에 도달 기록, 상담 날짜가 오늘이면 「상담 오늘」', async () => {
    const made = await svc().createLead(52, { name: '이하준', source: 'phone', note: '전화 문의 · 토요일 상담 희망' });
    const booked = await svc().addLeadTouch(53, made.id, { kind: 'book', note: '토 11:00 방문 상담', nextOn: TODAY });
    expect(booked.touches.map((t) => t.kind)).toEqual(['book', 'call']);     // 최근 것이 앞
    expect(booked).toMatchObject({ nextOn: TODAY, nextLabel: '상담 오늘', nextTone: 'warning' });
    const moved = await svc().moveLeadStage(53, made.id, { to: 'wait2nd' });
    expect(moved.stage).toBe('wait2nd');
    expect(moved.nextStages.map((s) => s.key)).toEqual(['second', 'hold']);
    const logs = await q.query(`SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [made.id]);
    expect(logs.map((l: { stage: string }) => l.stage)).toEqual(['first', 'wait2nd']);
    // 전이표 밖 — 뒤로는 못 간다 · 문장에 갈 수 있는 곳
    await expect(svc().moveLeadStage(53, made.id, { to: 'first' })).rejects.toMatchObject({
      response: { code: 'LEAD_STAGE_INVALID', message: expect.stringContaining('2차 상담 · 보류') },
    });
    // 머리의 경고와 카드 칩이 같은 판정이다
    const all = await svc().all(53, false, false);
    expect(all.intakeHead.alerts.find((a) => a.key === 'consultDue')!.count).toBeGreaterThanOrEqual(1);
  });

  it('A-03 상담 예약일에 오지 않음 — 예약 불참 한 줄 뒤 다음 예정일이 지났으면 「사후 관리 N일 밀림」, 다음 접촉이 적히면 풀린다', async () => {
    const made = await svc().createLead(52, { name: '정수아', source: 'instagram' });
    await svc().addLeadTouch(53, made.id, { kind: 'book', note: '수 17:00', nextOn: addDays(TODAY, -3) });
    const before = await svc().all(53, false, false);
    const row = () => before.leads.find((l) => l.id === made.id)!;
    expect(row()).toMatchObject({ nextLabel: '상담 3일 지남', nextTone: 'danger' });
    const noshow = await svc().addLeadTouch(53, made.id, { kind: 'noshow', note: '연락 없이 오지 않음 — 내일 다시 전화', nextOn: addDays(TODAY, -1) });
    expect(noshow).toMatchObject({ nextLabel: '사후 관리 1일 밀림', nextTone: 'danger' });
    const soon = await svc().addLeadTouch(53, made.id, { kind: 'call', note: '다시 예약 잡기로', nextOn: addDays(TODAY, 2) });
    expect(soon).toMatchObject({ nextLabel: '사후 관리 D-2', nextTone: 'info' });
    const done = await svc().addLeadTouch(53, made.id, { kind: 'memo', note: '보류' });
    expect(done).toMatchObject({ nextOn: null, nextLabel: null, nextTone: null });
    await expect(svc().addLeadTouch(53, made.id, { kind: 'memo', note: '   ' })).rejects.toMatchObject({ response: { code: 'LEAD_TOUCH_NOTE_REQUIRED' } });
    await expect(svc().addLeadTouch(53, 999999, { kind: 'memo', note: 'x' })).rejects.toMatchObject({ response: { code: 'LEAD_NOT_FOUND' } });
  });

  it('등록·등록 실패 건은 단계를 옮길 수 없다(LEAD_LOCKED) — 등록은 enroll, 실패는 resume 이 각자의 길', async () => {
    const made = await svc().createLead(52, { name: '최서준', source: 'referral', note: '학부모 김OO 소개' });
    await svc().failLead(53, made.id, { stopAt: 'before_first' });
    await expect(svc().moveLeadStage(53, made.id, { to: 'second' })).rejects.toMatchObject({ response: { code: 'LEAD_LOCKED' } });
    const failed = await svc().all(53, false, false);
    const row = failed.leads.find((l) => l.id === made.id)!;
    expect(row.nextStages).toEqual([]);
    // 실패 건에는 재촉 칩을 붙이지 않는다 — 끝난 결과다
    await svc().addLeadTouch(53, made.id, { kind: 'call', note: '재연락', nextOn: addDays(TODAY, -2) });
    expect((await svc().all(53, false, false)).leads.find((l) => l.id === made.id)).toMatchObject({ nextLabel: null });
    await q.query(`UPDATE lead SET stage = 'enrolled' WHERE id = $1`, [made.id]);
    await expect(svc().moveLeadStage(53, made.id, { to: 'hold' })).rejects.toMatchObject({ response: { code: 'LEAD_LOCKED' } });
    await expect(svc().moveLeadStage(53, 999999, { to: 'hold' })).rejects.toMatchObject({ response: { code: 'LEAD_NOT_FOUND' } });
  });

  it('K-108 §71 퍼널은 도달 기록으로 센다 — 옛 건은 지금 단계로만, 「보류면 2차를 거쳤겠지」는 세지 않는다 (N-45 · N-25)', async () => {
    await q.query(`DELETE FROM lead_stage_log`);
    await q.query(`DELETE FROM lead_touch`);
    await q.query(`DELETE FROM lead`);
    const at = (iso: string) => `${iso}T03:00:00Z`;
    // 옛 건 셋 — 기록 없이 시드가 박은 단계 (보류 · 등록 · 2차 대기)
    await q.query(`INSERT INTO lead (name, stage, created_at) VALUES ('옛보류','hold',$1), ('옛등록','enrolled',$1), ('옛대기','wait2nd',$1)`, [at('2026-03-05')]);
    // 새 건 셋 — 이 길로 들어와 옮긴 것
    const a = await svc().createLead(52, { name: '새A', source: 'kakao' });
    await svc().moveLeadStage(52, a.id, { to: 'wait2nd' });
    await svc().moveLeadStage(52, a.id, { to: 'second' });
    await svc().moveLeadStage(52, a.id, { to: 'hold' });
    const b = await svc().createLead(52, { name: '새B', source: 'phone' });
    await svc().moveLeadStage(52, b.id, { to: 'second' });   // 2차 대기를 건너뛰었다
    await svc().createLead(52, { name: '새C', source: 'blog' });
    await q.query(`UPDATE lead SET created_at = $1 WHERE id IN ($2,$3)`, [at('2026-03-20'), a.id, b.id]);
    await q.query(`UPDATE lead SET created_at = $1 WHERE name = '새C'`, [at('2026-04-02')]);   // 다음 달 유입 — 3월 판에 없다
    const m = (await exec().range('2026-03-01', '2026-03-31', true)).monthly!;
    expect(m.funnel.map((r) => [r.key, r.label, r.count, r.pct])).toEqual([
      ['inflow', '유입', 5, 100],
      ['first', '1차 상담', 2, 40],       // 새 A·B 만 기록이 있다 — 옛 건은 지금 단계가 1차가 아니다
      ['wait2nd', '2차 대기', 2, 40],     // 새 A(기록) + 옛대기(지금 단계)
      ['second', '2차 상담', 2, 40],      // 새 A·B — 옛보류는 거쳤는지 모른다
      ['enrolled', '등록', 1, 20],        // 옛등록(지금 단계)
    ]);
    expect(m.funnelSince).toBe(TODAY);
    const apr = (await exec().range('2026-04-01', '2026-04-30', true)).monthly!;
    expect(apr.funnel.map((r) => r.count)).toEqual([1, 1, 0, 0, 0]);
  });
});
