/** @file-guide
 * 목적: chreq-review-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §20 변경 요청 **반영**·반려 (C42).
 *
 * 원문 §20 의 안내가 그대로 계약이다 — 「겹치면 넣을 수 없습니다 ·
 * **반영하면 시간표가 바뀌고 이력에 남습니다**」. 그래서 여기서 증명하는 것은 셋이다.
 *   ① 반영은 **시간표를 바꾼다** — 상태만 적는 것이 아니다.
 *   ② 겹쳐서 막히면 **요청도 함께 되돌아간다** — 「시간표는 그대로인데 반영됨」이 없다.
 *   ③ 반려는 시간표를 건드리지 않고, **신청 사유를 덮어쓰지 않는다** (v4.18 · D-R13).
 *
 * ⚠ 이 파일은 **커밋되는 쓰기**를 부른다(ScheduleWriteService 가 제 트랜잭션을 연다).
 *   그래서 스크래치 DB(`*_test`)에서만 돌고, 만든 행은 스스로 지운다.
 */
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead, Zacc } from '../src/entities';
import { ConfigService } from '@nestjs/config';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
import { ZoomService } from '../src/modules/zoom/zoom.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

const SER = 910;
const RIVAL = 911;
const T1 = 921;
const T2 = 922;
const BOSS = 923;
const ON = '2026-11-04';
const ZACC_LABEL = `CHREQ-Z-${process.pid}`;

d('§20 변경 요청 반영 — 시간표가 실제로 바뀌고, 막히면 요청도 되돌아간다 (C42)', () => {
  let ds: DataSource;
  let svc: DrawerService;

  const q = (sql: string, p: unknown[] = []) => ds.query(sql, p) as Promise<Record<string, unknown>[]>;

  const chreq = async (reqType: string, payload: Record<string, unknown>, applyAll = false, byId = T1) => {
    const [r] = await q(
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id, apply_all)
       VALUES ($1,$2,$3,$4::jsonb,'원문 사유입니다',$5,$6) RETURNING id`,
      [SER, ON, reqType, JSON.stringify(payload), byId, applyAll],
    );
    return Number(r.id);
  };
  const occ = async () => (await q(
    `SELECT teacher_id, room_id, canceled, lower(span) AS from_at, upper(span) AS to_at
       FROM ser_occ WHERE ser_id = $1 AND on_date = $2`, [SER, ON],
  ))[0];
  const row = async (id: number) => (await q(
    `SELECT state, reason, reject_reason, resolved_by FROM chreq WHERE id = $1`, [id],
  ))[0] as { state: string; reason: string; reject_reason: string | null; resolved_by: string | null };

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    const cfg = { get: (k: string) => (k === 'ZOOM_ENC_KEY' ? '테스트 키' : undefined) } as unknown as ConfigService;
    svc = new DrawerService(ds.getRepository(Lead), new ScheduleWriteService(ds), new ZoomService(ds.getRepository(Zacc), cfg));
    await q(
      `INSERT INTO kind(key,name,color,cap,grp) VALUES('chreq_test','변경검증','#000000',4,'lesson')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q(`DELETE FROM staff WHERE email = ANY(ARRAY['ch921@t.kr','ch922@t.kr','ch923@t.kr']) AND id <> ALL($1)`, [[T1, T2, BOSS]]);
    await q(
      `INSERT INTO staff (id,name,email,role) VALUES
         ($1,'원 강사','ch921@t.kr','teacher'), ($2,'바뀔 강사','ch922@t.kr','teacher'),
         ($3,'처리 관리자','ch923@t.kr','admin')
       ON CONFLICT (id) DO NOTHING`, [T1, T2, BOSS],
    );
  });

  beforeEach(async () => {
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [[SER, RIVAL]]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [[SER, RIVAL]]);
    await q(`DELETE FROM chreq WHERE ser_id = $1`, [SER]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [[SER, RIVAL]]);
    await q(`DELETE FROM noti WHERE to_id = $1`, [T1]);
    await q(
      `INSERT INTO ser (id,kind_key,mode,start_min,end_min,rrule,from_date,to_date,teacher_id,title)
       VALUES ($1,'chreq_test','offline',600,660,'ONCE',$2,$2,$3,'MAP Reading')`, [SER, ON, T1],
    );
    await q(
      // 투영이 쓰는 것과 **같은 순간**이어야 한다 — KST 벽시계 10:00 은 UTC 01:00 이다
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,span)
       VALUES ($1,$2::date,$3, tstzrange(($2 || ' 10:00+09')::timestamptz, ($2 || ' 11:00+09')::timestamptz, '[)'))`,
      [SER, ON, T1],
    );
  });

  afterAll(async () => {
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [[SER, RIVAL]]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [[SER, RIVAL]]);
    await q(`DELETE FROM chreq WHERE ser_id = $1`, [SER]);
    await q(`DELETE FROM log WHERE entity = 'chreq' AND actor_id = $1`, [BOSS]);
    await q(`DELETE FROM noti WHERE to_id = $1`, [T1]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [[SER, RIVAL]]);
    if (ds?.isInitialized) await ds.destroy();
  });

  it('강사 변경을 반영하면 **시간표의 강사가 실제로 바뀐다** — 그리고 이력·알림이 남는다', async () => {
    const id = await chreq('teacher', { teacherId: T2 });
    const out = await svc.reviewChangeRequest(id, BOSS, { decision: 'approve' });

    expect(out).toMatchObject({ state: 'approved' });
    expect(out.applied).toBe('강사 → 바뀔 강사');
    expect(Number((await occ()).teacher_id)).toBe(T2);
    expect(await row(id)).toMatchObject({ state: 'approved', reason: '원문 사유입니다', reject_reason: null });

    const [log] = await q(`SELECT action FROM log WHERE entity='chreq' AND entity_id=$1`, [id]);
    expect(log.action).toBe('apply');
    const [noti] = await q(`SELECT body FROM noti WHERE to_id=$1 ORDER BY id DESC LIMIT 1`, [T1]);
    expect(String(noti.body)).toContain('반영');
  });

  it('시간 이동을 반영하면 회차 시각이 바뀐다', async () => {
    const id = await chreq('time_move', { startMin: 1200, endMin: 1290 });
    const out = await svc.reviewChangeRequest(id, BOSS, { decision: 'approve' });
    expect(out.applied).toBe('20:00–21:30 로 이동');
    const after = await occ();
    expect(new Date(String(after.from_at)).toISOString()).toContain('T11:00');
  });

  it('휴강을 반영하면 그 회차가 취소된다 — 규칙은 그대로 둔다 (EXC · D-R21)', async () => {
    const id = await chreq('cancel', {});
    const out = await svc.reviewChangeRequest(id, BOSS, { decision: 'approve' });
    expect(out.applied).toBe('휴강');
    const [exc] = await q(`SELECT canceled FROM exc WHERE ser_id=$1 AND on_date=$2`, [SER, ON]);
    expect(exc.canceled).toBe(true);
    const [ser] = await q(`SELECT rrule FROM ser WHERE id=$1`, [SER]);
    expect(ser.rrule).toBe('ONCE');
  });

  it('**겹쳐서 막히면 요청도 함께 되돌아간다** — 시간표는 그대로인데 반영됨이 없다 (D-R43)', async () => {
    // 같은 시각에 바뀔 강사의 다른 수업을 둔다 — EXCLUDE 가 막을 자리다
    await q(
      `INSERT INTO ser (id,kind_key,mode,start_min,end_min,rrule,from_date,to_date,teacher_id,title)
       VALUES ($1,'chreq_test','offline',600,660,'ONCE',$2,$2,$3,'겹치는 수업')`, [RIVAL, ON, T2],
    );
    await q(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,span)
       VALUES ($1,$2::date,$3, tstzrange(($2 || ' 10:00+09')::timestamptz, ($2 || ' 11:00+09')::timestamptz, '[)'))`,
      [RIVAL, ON, T2],
    );

    const id = await chreq('teacher', { teacherId: T2 });
    await expect(svc.reviewChangeRequest(id, BOSS, { decision: 'approve' })).rejects.toBeDefined();

    // 요청도 시간표도 **아무것도 바뀌지 않았다**
    expect(await row(id)).toMatchObject({ state: 'pending' });
    expect(Number((await occ()).teacher_id)).toBe(T1);
    expect(await q(`SELECT 1 FROM log WHERE entity='chreq' AND entity_id=$1`, [id])).toHaveLength(0);
  });

  it('반려는 시간표를 건드리지 않고 **신청 사유를 덮어쓰지 않는다** (v4.18 · D-R13)', async () => {
    const id = await chreq('teacher', { teacherId: T2 });
    await expect(svc.reviewChangeRequest(id, BOSS, { decision: 'reject' }))
      .rejects.toMatchObject({ response: { code: 'REJECT_REASON_REQUIRED' } });

    const out = await svc.reviewChangeRequest(id, BOSS, { decision: 'reject', reason: '그날은 진단고사가 있습니다' });
    expect(out).toMatchObject({ state: 'rejected', applied: null });
    expect(await row(id)).toMatchObject({
      state: 'rejected', reason: '원문 사유입니다', reject_reason: '그날은 진단고사가 있습니다',
    });
    expect(Number((await occ()).teacher_id)).toBe(T1);
  });

  it('한 줄은 한 번만 처리된다 · 자기 요청은 자기가 못 한다', async () => {
    const id = await chreq('teacher', { teacherId: T2 });
    await svc.reviewChangeRequest(id, BOSS, { decision: 'approve' });
    await expect(svc.reviewChangeRequest(id, BOSS, { decision: 'approve' }))
      .rejects.toMatchObject({ response: { code: 'CHREQ_NOT_PENDING' } });

    const mine = await chreq('cancel', {}, false, BOSS);
    await expect(svc.reviewChangeRequest(mine, BOSS, { decision: 'approve' }))
      .rejects.toMatchObject({ response: { code: 'SELF_APPROVAL_FORBIDDEN' } });
  });

  /**
   * C42 에서는 이 갈래만 「반영 경로가 없다」로 막혀 있었다 — 줌 계정을 붙이는 코드가
   * 저장소에 하나도 없었기 때문이다. **C48 에서 경로가 생겼다**(대표 결정 2026-09-12).
   * 이제 승인하면 계정이 실제로 붙고, 붙는 일과 요청 종결이 한 트랜잭션이다.
   */
  it('줌 계정 변경도 반영된다 — 계정이 실제로 붙는다 (C48 에서 열림)', async () => {
    await q(`UPDATE ser SET mode='online' WHERE id=$1`, [SER]);
    const [z] = (await ds.query(
      `INSERT INTO zacc (label, login_email, login_secret, join_url, active)
       VALUES ($1,$2,'\\x00'::bytea,'https://zoom.us/j/99',true) RETURNING id`,
      [ZACC_LABEL, `chreq-z-${process.pid}@t.kr`],
    )) as { id: string }[];
    const zaccId = Number(z.id);
    const id = await chreq('room', { zaccId });
    await expect(svc.reviewChangeRequest(id, BOSS, { decision: 'approve' }))
      .resolves.toMatchObject({ state: 'approved' });
    expect(await row(id)).toMatchObject({ state: 'approved' });

    const [{ n }] = (await ds.query(
      `SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = $1 AND zacc_id = $2`, [SER, zaccId],
    )) as { n: number }[];
    expect(n).toBeGreaterThan(0);
    await ds.query(`DELETE FROM zassign WHERE zacc_id = $1`, [zaccId]);
    await ds.query(`DELETE FROM zlog WHERE zacc_id = $1`, [zaccId]);
    await ds.query(`UPDATE ser_occ SET zacc_id = NULL WHERE zacc_id = $1`, [zaccId]);
    await ds.query(`DELETE FROM zacc WHERE id = $1`, [zaccId]);
  });

  it('승인 대기함 줄이 무엇을 바꾸는지 말한다 — 네 갈래가 두 모양까지 모두 처리 가능하다 (C48)', async () => {
    const ok = await chreq('teacher', { teacherId: T2 });
    const zoom = await chreq('room', { zaccId: 1 });
    const flow = (await svc.all(BOSS, true, true, false)).approvals;
    const rows = [...flow.waiting, ...flow.back, ...flow.mine];
    expect(rows.find((r) => r.kind === 'chreq' && r.id === ok))
      .toMatchObject({ canAct: true, asked: '강사 → 바뀔 강사' });
    expect(rows.find((r) => r.kind === 'chreq' && r.id === zoom)).toMatchObject({ canAct: true });
  });
});
