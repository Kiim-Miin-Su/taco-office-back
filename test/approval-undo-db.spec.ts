/** @file-guide
 * 목적: approval-undo-db.spec.ts (test) — §14 결재 되돌리기(N-84) · 강사 교재 변경/GPA 회차 요청(N-99) · 서랍 결재 감사 줄(N-73)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 원문 §14 머리 「반려에도 사유가 남고, **모든 처리는 되돌리기로 취소됩니다**」 (N-84 채택 · W11).
 *
 * 증명하는 것 —
 *   ① 시급 승인 되돌리기는 **그 승인이 넣은 줄**만 지운다 — 뒤에 줄이 더 있거나 그 달 정산이 확정됐으면 409 로 멈추고 아무것도 안 바뀐다.
 *   ② 시간대는 앞 값으로 · 반려는 상태만 · 요청은 다시 대기(pending)로 선다. 그 사이 바뀌었으면 409 UNDO_STALE.
 *   ③ 변경 요청 반영 되돌리기는 **일정 되돌리기 토큰 그대로** 시간표를 되돌리고 요청을 대기로 — 한 트랜잭션이다.
 *   ④ 토큰은 본인 것만 · 변조 · 만료는 400 BAD_UNDO_TOKEN. 이미 간 알림은 그대로다(N-55 ②).
 *   ⑤ 강사의 교재 변경 · GPA 회차 요청(N-99) — 입력 방어 · 승인(GPA 기록 한 줄) · 되돌리기(그 기록 삭제).
 *   ⑥ 감사 — 쓰기마다 한 줄, 409 로 막힌 쓰기는 0 줄 (N-73). 결재 줄은 표의 이름(REQ · CHREQ 대문자)이다(W11 A' 후속).
 *   ⑦ 한 번만 — 되돌린 뒤 같은 결정으로 다시 처리하면 옛 토큰은 409 · 새 토큰만 통한다(토큰이 감사 줄에 묶인다 · W11 A' 후속).
 *   ⑧ 줌 계정 갈래 — 앞 배정으로 되돌린다(배정 때 생긴 예외 줄도 걷힌다) · 그 사이 다른 배정이 있으면 409 (W11 A' 후속).
 *
 * ⚠ 이 파일은 **커밋되는 쓰기**를 부른다(일정 쓰기가 제 트랜잭션을 연다). 스크래치 DB(`*_test`)에서만 돌고 만든 행은 스스로 지운다.
 *   이 스위트 전용 id 97xx 만 쓴다.
 */
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { dataSourceOptions } from '../src/data-source';
import { GpaCycle, Lead, Ser, Zacc } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { issueApprovalUndo, readApprovalUndo } from '../src/modules/drawer/approval-undo';
import { GpaService } from '../src/modules/gpa/gpa.service';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
import { sign } from '../src/modules/schedule/schedule.undo';
import { TeacherService } from '../src/modules/teacher/teacher.service';
import { ZoomService } from '../src/modules/zoom/zoom.service';
import { todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(90_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

const T = 9711;
const BOSS = 9712;
const OTHER = 9713;
const STU = 9721;
const SER_CH = 9731;
const SER_GPA = 9732;
const SER_Z = 9733;
const CYCLE = 9741;
const LIB = 9751;
const ISSUE = 9761;
const ON = '2026-11-05';
const STAFF = [T, BOSS, OTHER];

d('§14 결재 되돌리기 (N-84) · 강사 요청 두 갈래 (N-99) · 결재 감사 줄 (N-73)', () => {
  let ds: DataSource;
  let drawer: DrawerService;
  let teacher: TeacherService;
  let zoom: ZoomService;
  /** 줌 계정 둘 — 이 스위트가 만들고 지운다 */
  let Z1 = 0;
  let Z2 = 0;
  /** 이 스위트가 새로 넣은 코드표 줄 — 끝나면 이것만 지운다 */
  const made = { tzg: [] as number[], kind: [] as string[], sub: [] as string[], gpasvc: [] as string[] };

  const q = <T0 = Record<string, unknown>>(sql: string, p: unknown[] = []) => ds.query(sql, p) as Promise<T0[]>;
  const logCount = async (entity: string, id: number, action: string) =>
    Number((await q<{ n: string }>(`SELECT count(*)::text n FROM log WHERE entity = $1 AND entity_id = $2 AND action = $3`, [entity, id, action]))[0].n);
  const notiCount = async () => Number((await q<{ n: string }>(`SELECT count(*)::text n FROM noti WHERE to_id = $1`, [T]))[0].n);
  const req = async (id: number) => (await q<{ state: string; resolved_by: string | null; reject_reason: string | null }>(
    `SELECT state, resolved_by, reject_reason FROM req WHERE id = $1`, [id]))[0];
  const openReq = async (reqType: string, payload: Record<string, unknown>) => Number((await q<{ id: string }>(
    `INSERT INTO req (staff_id, req_type, payload) VALUES ($1,$2,$3::jsonb) RETURNING id`, [T, reqType, JSON.stringify(payload)]))[0].id);
  const occStart = async () => (await q<{ h: string }>(
    `SELECT to_char(lower(span) AT TIME ZONE 'Asia/Seoul','HH24:MI') AS h FROM ser_occ WHERE ser_id = $1 AND on_date = $2`, [SER_CH, ON]))[0]?.h;

  const SERS = [SER_CH, SER_GPA, SER_Z];
  const cleanup = async () => {
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM gpa_use WHERE student_id = $1`, [STU]);
    await q(`DELETE FROM req WHERE staff_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM chreq WHERE ser_id = ANY($1)`, [SERS]);
    await q(`DELETE FROM zlog WHERE zacc_id = ANY($1)`, [[Z1, Z2]]);
    await q(`DELETE FROM zassign WHERE zacc_id = ANY($1)`, [[Z1, Z2]]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [SERS]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [SERS]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [SERS]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [SERS]);
    await q(`DELETE FROM issue WHERE id = $1`, [ISSUE]);
    await q(`DELETE FROM lib WHERE id = $1`, [LIB]);
    await q(`DELETE FROM gpa_cycle WHERE id = $1`, [CYCLE]);
    await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM wage WHERE staff_id = ANY($1) OR approved_by = ANY($1)`, [STAFF]);
    await q(`DELETE FROM stu WHERE id = $1`, [STU]);
  };

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    const cfg = { get: (k: string) => (k === 'ZOOM_ENC_KEY' ? '테스트 키' : undefined) } as unknown as ConfigService;
    zoom = new ZoomService(ds.getRepository(Zacc), cfg);
    drawer = new DrawerService(
      ds.getRepository(Lead), new ScheduleWriteService(ds), zoom,
      new GpaService(ds.getRepository(GpaCycle)),
    );
    teacher = new TeacherService(ds.getRepository(Ser));
    await cleanup();
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [STAFF]);
    await q(
      `INSERT INTO staff (id,name,email,role,tz) VALUES
         ($1,'되돌림 강사','undo9711@t.kr','teacher','Asia/Seoul'),
         ($2,'되돌림 관리자','undo9712@t.kr','admin','Asia/Seoul'),
         ($3,'다른 매니저','undo9713@t.kr','manager','Asia/Seoul')`, STAFF,
    );
    /*
     * 코드표 — **없을 때만** 넣고 끝나면 넣은 것만 지운다. 시간대 그룹은 id 를 적지 않는다(적으면 시퀀스가 그 값을 몰라
     * 이웃 스위트의 다음 INSERT 가 같은 id 로 부딪힌다 — drawer-w5-db 17-1).
     */
    for (const [name, tz] of [['한국 (KST)', 'Asia/Seoul'], ['미국 동부', 'America/New_York']]) {
      if ((await q(`SELECT id FROM tzg WHERE tz = $1 LIMIT 1`, [tz])).length === 0) {
        made.tzg.push(Number((await q<{ id: string }>(`INSERT INTO tzg (name, tz) VALUES ($1, $2) RETURNING id`, [name, tz]))[0].id));
      }
    }
    const once = async (table: 'kind' | 'sub' | 'gpasvc', key: string, sql: string) => {
      if ((await q(`SELECT key FROM ${table} WHERE key = $1`, [key])).length === 0) { await q(sql); made[table].push(key); }
    };
    await once('kind', 'undo_test', `INSERT INTO kind(key,name,color,cap,grp) VALUES('undo_test','되돌림검증','#000000',4,'lesson')`);
    await once('kind', 'gpa', `INSERT INTO kind(key,name,color,cap,grp) VALUES('gpa','GPA','#7C3AED',4,'lesson')`);
    await once('sub', 'undo-sub', `INSERT INTO sub(key,name,color) VALUES('undo-sub','MAP Math','#2563EB')`);
    await once('gpasvc', 'quiz', `INSERT INTO gpasvc(key,name,point) VALUES('quiz','Quiz 대비',2)`);
    // 줌 계정 둘 — 비밀 칸은 아무 바이트(이 스위트는 비밀을 읽지 않는다)
    // 앞 실행이 남긴 계정이 있으면 그 배정 · 사용 기록부터 걷고 지운다(zassign 은 계정을 RESTRICT 로 잡는다)
    const oldZ = `SELECT id FROM zacc WHERE label IN ('UNDO-Z1','UNDO-Z2')`;
    await q(`DELETE FROM zlog WHERE zacc_id IN (${oldZ})`);
    await q(`DELETE FROM zassign WHERE zacc_id IN (${oldZ})`);
    await q(`UPDATE ser_occ SET zacc_id = NULL WHERE zacc_id IN (${oldZ})`);
    await q(`DELETE FROM zacc WHERE label IN ('UNDO-Z1','UNDO-Z2')`);
    [Z1, Z2] = (await q<{ id: string }>(
      `INSERT INTO zacc (label, login_email, login_secret, join_url, active) VALUES
         ('UNDO-Z1','undo-z1@t.invalid',decode('00','hex'),'https://zoom.us/j/9701',true),
         ('UNDO-Z2','undo-z2@t.invalid',decode('00','hex'),'https://zoom.us/j/9702',true) RETURNING id`,
    )).map((r) => Number(r.id));
  });

  beforeEach(async () => {
    await cleanup();
    await q(`INSERT INTO wage (staff_id, rate, from_date) VALUES ($1, 42000, '2026-01-01')`, [T]);
    await q(`UPDATE staff SET tz = 'Asia/Seoul' WHERE id = $1`, [T]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'박하경','10')`, [STU]);
    // 변경 요청 대상 — 투영이 쓰는 것과 같은 순간(KST 10:00)
    await q(
      `INSERT INTO ser (id,kind_key,mode,start_min,end_min,rrule,from_date,to_date,teacher_id,title)
       VALUES ($1,'undo_test','offline',600,660,'ONCE',$2,$2,$3,'되돌림 수업')`, [SER_CH, ON, T],
    );
    await q(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,span)
       VALUES ($1,$2::date,$3, tstzrange(($2 || ' 10:00+09')::timestamptz, ($2 || ' 11:00+09')::timestamptz, '[)'))`, [SER_CH, ON, T],
    );
    // GPA 수업 한 회차 — 20:00–20:40 · 명단 박하경
    await q(
      `INSERT INTO ser (id,kind_key,mode,start_min,end_min,rrule,from_date,to_date,teacher_id,title)
       VALUES ($1,'gpa','online',1200,1240,'ONCE',$2,$2,$3,'GPA 관리')`, [SER_GPA, ON, T],
    );
    await q(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [SER_GPA, STU]);
    await q(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,span)
       VALUES ($1,$2::date,$3, tstzrange(($2 || ' 20:00+09')::timestamptz, ($2 || ' 20:40+09')::timestamptz, '[)'))`, [SER_GPA, ON, T],
    );
    await q(`INSERT INTO gpa_cycle (id, no, from_date, to_date, closed) VALUES ($1, 97, '2026-10-25', '2026-11-21', false)`, [CYCLE]);
    await q(`INSERT INTO lib (id, code, title, sub_key, se_te) VALUES ($1,'UNDO-LIB','MAP Math Level 3','undo-sub','SE')`, [LIB]);
    await q(`INSERT INTO issue (id, lib_id, student_id, issued_on, state) VALUES ($1,$2,$3,'2026-09-01','ok')`, [ISSUE, LIB, STU]);
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM zacc WHERE id = ANY($1)`, [[Z1, Z2]]);
    // 이 스위트가 넣은 코드표만 — 원래 있던 줄은 건드리지 않는다
    await q(`DELETE FROM tzg WHERE id = ANY($1)`, [made.tzg]);
    await q(`DELETE FROM gpasvc WHERE key = ANY($1)`, [made.gpasvc]);
    await q(`DELETE FROM sub WHERE key = ANY($1)`, [made.sub]);
    await q(`DELETE FROM kind WHERE key = ANY($1)`, [made.kind]);
    if (ds?.isInitialized) await ds.destroy();
  });

  /* ── ① 시급 ─────────────────────────────────────────────────────────────── */

  it('시급 승인 되돌리기 — 그 승인이 넣은 줄만 지우고 요청은 대기로 · 감사 한 줄 · 알림은 그대로', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });
    const out = await drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true);
    expect(out.undoToken).toEqual(expect.any(String));
    expect(Date.parse(out.undoExpiresAt!)).toBeGreaterThan(Date.now());
    expect((await q(`SELECT id FROM wage WHERE staff_id = $1`, [T])).length).toBe(2);
    const sent = await notiCount();

    const res = await drawer.undoApproval(BOSS, out.undoToken!, true);
    expect(res).toEqual({ id, target: 'req', state: 'pending', reverted: '시급 줄 삭제' });
    const lines = await q<{ rate: number; from_date: string }>(
      `SELECT rate, to_char(from_date,'YYYY-MM-DD') AS from_date FROM wage WHERE staff_id = $1`, [T]);
    expect(lines).toEqual([{ rate: 42000, from_date: '2026-01-01' }]);
    expect(await req(id)).toEqual({ state: 'pending', resolved_by: null, reject_reason: null });
    expect(await logCount('REQ', id, 'undo')).toBe(1);
    // N-55 ② — 이미 간 알림을 지우지도 새로 짓지도 않는다
    expect(await notiCount()).toBe(sent);
    // 같은 토큰을 다시 — 이제 그 처리는 지난 일이다(요청이 대기다)
    await expect(drawer.undoApproval(BOSS, out.undoToken!, true)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    expect(await logCount('REQ', id, 'undo')).toBe(1);
  });

  it('시급 — 뒤에 줄이 더 생겼으면 409 이고 아무것도 안 바뀐다(마지막 줄만 지운다 · 소급 없음)', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });
    const out = await drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true);
    await q(`INSERT INTO wage (staff_id, rate, from_date) VALUES ($1, 47000, '2099-01-01')`, [T]);
    await expect(drawer.undoApproval(BOSS, out.undoToken!, true)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    expect((await q(`SELECT id FROM wage WHERE staff_id = $1`, [T])).length).toBe(3);
    expect((await req(id)).state).toBe('approved');
    expect(await logCount('REQ', id, 'undo')).toBe(0);
  });

  it('시급 — 그 달 정산이 확정됐으면 409 UNDO_PAYOUT_CONFIRMED · 시급 권한이 없으면 403', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });
    const out = await drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true);
    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).rejects.toMatchObject({ response: { code: 'WAGE_REVIEW_FORBIDDEN' } });
    await q(
      `INSERT INTO payout (staff_id, year_month, hours, gross, net, state, confirmed_by, confirmed_at)
       VALUES ($1, $2, 1, 1, 1, 'confirmed', $3, now())`, [T, todayKst().slice(0, 7), BOSS],
    );
    await expect(drawer.undoApproval(BOSS, out.undoToken!, true)).rejects.toMatchObject({ response: { code: 'UNDO_PAYOUT_CONFIRMED' } });
    expect((await q(`SELECT id FROM wage WHERE staff_id = $1`, [T])).length).toBe(2);
    expect((await req(id)).state).toBe('approved');
    expect(await logCount('REQ', id, 'undo')).toBe(0);
  });

  /* ── ② 시간대 · 반려 · 토큰 ───────────────────────────────────────────────── */

  it('시간대 승인 되돌리기 — 앞 값으로 · 그 사이 또 바뀌었으면 409', async () => {
    const id = await openReq('tz_change', { from: 'Asia/Seoul', tz: 'America/New_York' });
    const out = await drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true);
    expect((await q<{ tz: string }>(`SELECT tz FROM staff WHERE id = $1`, [T]))[0].tz).toBe('America/New_York');
    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).resolves.toMatchObject({ reverted: '시간대 되돌림' });
    expect((await q<{ tz: string }>(`SELECT tz FROM staff WHERE id = $1`, [T]))[0].tz).toBe('Asia/Seoul');

    const id2 = await openReq('tz_change', { from: 'Asia/Seoul', tz: 'America/New_York' });
    const out2 = await drawer.reviewRequest(id2, BOSS, { decision: 'approve' }, true);
    await q(`UPDATE staff SET tz = 'Asia/Seoul' WHERE id = $1`, [T]);
    await expect(drawer.undoApproval(BOSS, out2.undoToken!, true)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    expect((await req(id2)).state).toBe('approved');
  });

  it('반려 되돌리기는 상태만 — 사유를 비우고 대기로 · 감사 줄 before 에 사유가 남는다', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 99000 });
    const out = await drawer.reviewRequest(id, BOSS, { decision: 'reject', reason: '근거가 없습니다' }, true);
    expect((await req(id)).reject_reason).toBe('근거가 없습니다');
    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).resolves.toMatchObject({ state: 'pending', reverted: '상태만' });
    expect(await req(id)).toEqual({ state: 'pending', resolved_by: null, reject_reason: null });
    const [row] = await q<{ before: { rejectReason: string } }>(
      `SELECT before FROM log WHERE entity = 'REQ' AND entity_id = $1 AND action = 'undo'`, [id]);
    expect(row.before.rejectReason).toBe('근거가 없습니다');
  });

  it('토큰은 본인 것만 · 변조 · 만료는 400 BAD_UNDO_TOKEN (서버 판정 · 화면이 풀지 않는다)', async () => {
    const id = await openReq('tz_change', { from: 'Asia/Seoul', tz: 'America/New_York' });
    const out = await drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true);
    await expect(drawer.undoApproval(OTHER, out.undoToken!, true)).rejects.toMatchObject({ response: { code: 'BAD_UNDO_TOKEN' } });
    const [body, sig] = out.undoToken!.split('.');
    await expect(drawer.undoApproval(BOSS, `${body}x.${sig}`, true)).rejects.toMatchObject({ response: { code: 'BAD_UNDO_TOKEN' } });
    // 만료 — 10분 뒤에는 서명이 맞아도 읽지 않는다
    expect(readApprovalUndo(out.undoToken!, BOSS, Date.now() + 11 * 60_000)).toBeNull();
    expect(readApprovalUndo(out.undoToken!, BOSS)).not.toBeNull();
    // 일정 되돌리기와 **같은 서명 함수**지만 입력 앞말이 달라 서로 흉내 내지 못한다 — 앞말 없이 서명한 본문은 읽지 않는다
    const plain = issueApprovalUndo(BOSS, { target: 'req', id, decision: 'approve', logId: 1, effect: { kind: 'none' } }).token.split('.')[0];
    expect(readApprovalUndo(`${plain}.${sign(plain)}`, BOSS)).toBeNull();
    await expect(drawer.undoApproval(BOSS, `${plain}.${sign(plain)}`, true)).rejects.toMatchObject({ response: { code: 'BAD_UNDO_TOKEN' } });
    expect((await req(id)).state).toBe('approved');
  });

  /* ── ③ 변경 요청 ─────────────────────────────────────────────────────────── */

  it('변경 요청 반영 되돌리기 — 일정 되돌리기 토큰으로 시간표를 되돌리고 요청은 대기로 · 한 트랜잭션', async () => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO chreq (ser_id,on_date,req_type,payload,reason,by_id) VALUES ($1,$2,'time_move','{"startMin":840,"endMin":900}'::jsonb,'옮겨 주세요',$3) RETURNING id`,
      [SER_CH, ON, T],
    );
    const id = Number(c.id);
    const out = await drawer.reviewChangeRequest(id, BOSS, { decision: 'approve' });
    expect(out.undoToken).toEqual(expect.any(String));
    expect(await occStart()).toBe('14:00');
    const sent = await notiCount();

    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).resolves.toMatchObject({ target: 'chreq', reverted: '시간표 되돌림' });
    expect(await occStart()).toBe('10:00');
    const [row] = await q<{ state: string; resolved_by: string | null }>(`SELECT state, resolved_by FROM chreq WHERE id = $1`, [id]);
    expect(row).toEqual({ state: 'pending', resolved_by: null });
    expect(await logCount('CHREQ', id, 'undo')).toBe(1);
    expect(await notiCount()).toBe(sent);
  });

  it('변경 요청 — 그 사이 같은 수업이 또 바뀌었으면 409 이고 요청도 반영 그대로다', async () => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO chreq (ser_id,on_date,req_type,payload,reason,by_id) VALUES ($1,$2,'time_move','{"startMin":840,"endMin":900}'::jsonb,'옮겨 주세요',$3) RETURNING id`,
      [SER_CH, ON, T],
    );
    const id = Number(c.id);
    const out = await drawer.reviewChangeRequest(id, BOSS, { decision: 'approve' });
    await new ScheduleWriteService(ds).patch(SER_CH, { scope: 'this', onDate: ON, startMin: 900, endMin: 960 } as never);
    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    expect(await occStart()).toBe('15:00');
    expect((await q<{ state: string }>(`SELECT state FROM chreq WHERE id = $1`, [id]))[0].state).toBe('approved');
    expect(await logCount('CHREQ', id, 'undo')).toBe(0);
  });

  it('변경 요청 반려 되돌리기는 상태만 — 시간표는 바뀐 적이 없다', async () => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO chreq (ser_id,on_date,req_type,payload,reason,by_id) VALUES ($1,$2,'cancel','{}'::jsonb,'쉬어야 합니다',$3) RETURNING id`,
      [SER_CH, ON, T],
    );
    const id = Number(c.id);
    const out = await drawer.reviewChangeRequest(id, BOSS, { decision: 'reject', reason: '대체 강사를 먼저 찾아 주세요' });
    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).resolves.toMatchObject({ reverted: '상태만' });
    const [row] = await q<{ state: string; reject_reason: string | null }>(`SELECT state, reject_reason FROM chreq WHERE id = $1`, [id]);
    expect(row).toEqual({ state: 'pending', reject_reason: null });
    expect(await occStart()).toBe('10:00');
  });

  /* ── ⑤ 강사 요청 두 갈래 (N-99) ─────────────────────────────────────────── */

  it('교재 변경 요청 — 사유 필수 · 쓰는 교재만 · 한 교재에 하나 · 승인은 상태와 알림만(배부 불변)', async () => {
    await expect(teacher.createSettingRequest(T, { reqType: 'book_change', studentId: STU, issueId: ISSUE }))
      .rejects.toMatchObject({ response: { code: 'REASON_REQUIRED' } });
    await expect(teacher.createSettingRequest(OTHER, { reqType: 'book_change', studentId: STU, issueId: ISSUE, reason: '어렵습니다' }))
      .rejects.toMatchObject({ status: 404 });
    const made = await teacher.createSettingRequest(T, { reqType: 'book_change', studentId: STU, issueId: ISSUE, reason: '너무 어렵습니다' });
    expect(made).toMatchObject({ reqType: 'book_change', label: '교재 변경', asked: 'MAP Math Level 3', state: 'pending' });
    await expect(teacher.createSettingRequest(T, { reqType: 'book_change', studentId: STU, issueId: ISSUE, reason: '또' }))
      .rejects.toMatchObject({ response: { code: 'REQ_PENDING' } });
    const [row] = await q<{ student_id: string; payload: Record<string, unknown> }>(`SELECT student_id, payload FROM req WHERE id = $1`, [made.id]);
    expect(Number(row.student_id)).toBe(STU);
    expect(row.payload).toMatchObject({ issueId: ISSUE, bookTitle: 'MAP Math Level 3', subjectName: 'MAP Math', studentName: '박하경', message: '너무 어렵습니다' });

    // 홈 「교재 변경 요청 중」 · 수업 안내 교재 행의 단추 상태 — 서버가 센다
    expect((await teacher.home(T)).todo.openBookChanges).toBe(1);

    // §14 카드 — 회색 제목 「학생 · 과목」 · 분류 「교재 변경」 · 사유 인용 줄
    const inbox = (await drawer.all(BOSS, true, true)).approvals.inbox;
    const card = inbox.find((r) => r.kind === 'req' && r.id === made.id)!;
    expect(card).toMatchObject({ title: '박하경 · MAP Math', category: 'book_change', reason: '너무 어렵습니다', asked: 'MAP Math Level 3', canAct: true });

    const out = await drawer.reviewRequest(made.id, BOSS, { decision: 'approve' }, false);
    expect(out).toMatchObject({ state: 'approved', applied: null });
    // 새 교재를 정하지 않는다 — 배부는 그대로(관리자가 §38 에서 바꾼다)
    expect((await q<{ state: string; lib_id: string }>(`SELECT state, lib_id FROM issue WHERE id = $1`, [ISSUE]))[0]).toEqual({ state: 'ok', lib_id: String(LIB) });
    expect(await logCount('REQ', made.id, 'approve')).toBe(1);
    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).resolves.toMatchObject({ reverted: '상태만' });
    expect((await req(made.id)).state).toBe('pending');
  });

  it('교재 변경 — 반환한 교재는 409 BOOK_NOT_IN_USE', async () => {
    await q(`UPDATE issue SET state = 'returned', returned_on = '2026-09-10' WHERE id = $1`, [ISSUE]);
    await expect(teacher.createSettingRequest(T, { reqType: 'book_change', studentId: STU, issueId: ISSUE, reason: '바꿔 주세요' }))
      .rejects.toMatchObject({ response: { code: 'BOOK_NOT_IN_USE' } });
  });

  it('GPA 회차 요청 — 내 GPA 회차 · 명단 학생 · 규정 서비스 · 열린 사이클 · 승인하면 GPA 기록 한 줄 · 되돌리면 그 기록이 사라진다', async () => {
    await expect(teacher.createSettingRequest(T, { reqType: 'gpa_request', serId: SER_CH, onDate: ON, studentId: STU, svcKey: 'quiz' }))
      .rejects.toMatchObject({ response: { code: 'GPA_SER_NOT_GPA' } });
    await expect(teacher.createSettingRequest(OTHER, { reqType: 'gpa_request', serId: SER_GPA, onDate: ON, studentId: STU, svcKey: 'quiz' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(teacher.createSettingRequest(T, { reqType: 'gpa_request', serId: SER_GPA, onDate: ON, studentId: STU, svcKey: 'nope' }))
      .rejects.toMatchObject({ status: 404 });

    const made = await teacher.createSettingRequest(T, {
      reqType: 'gpa_request', serId: SER_GPA, onDate: ON, studentId: STU, svcKey: 'quiz', reason: '내신 대비 · 이 시간대만 됩니다',
    });
    expect(made).toMatchObject({ reqType: 'gpa_request', label: 'GPA 회차', asked: `${ON} 20:00–20:40` });
    await expect(teacher.createSettingRequest(T, { reqType: 'gpa_request', serId: SER_GPA, onDate: ON, studentId: STU, svcKey: 'quiz' }))
      .rejects.toMatchObject({ response: { code: 'REQ_PENDING' } });

    const inbox = (await drawer.all(BOSS, true, true)).approvals;
    const card = inbox.inbox.find((r) => r.kind === 'req' && r.id === made.id)!;
    expect(card).toMatchObject({ title: '박하경 · Quiz 대비', category: 'gpa_request', categoryLabel: 'GPA 요청', asked: `${ON} 20:00–20:40` });
    expect(inbox.categories.find((c) => c.key === 'gpa_request')?.count).toBeGreaterThanOrEqual(1);

    const out = await drawer.reviewRequest(made.id, BOSS, { decision: 'approve' }, false);
    const uses = await q<{ id: string; state: string; points: number; start_min: number; coord_id: string; ser_id: string }>(
      `SELECT id, state, points, start_min, coord_id, ser_id FROM gpa_use WHERE student_id = $1`, [STU]);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ state: 'wait', points: 2, start_min: 1200, coord_id: String(T), ser_id: String(SER_GPA) });
    expect(out.applied).toContain('2p');

    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).resolves.toMatchObject({ reverted: 'GPA 기록 삭제' });
    expect(await q(`SELECT id FROM gpa_use WHERE student_id = $1`, [STU])).toHaveLength(0);
    expect((await req(made.id)).state).toBe('pending');
  });

  it('GPA 회차 요청 창 — 쓰기와 같은 판정으로 회차를 고른다(내 GPA 회차 · 휴강 아님 · 열린 사이클 안 · 그날 명단)', async () => {
    const mine = async (who: number) => (await teacher.gpaRequestOptions(who)).occurrences.filter((o) => o.serId === SER_GPA || o.serId === SER_CH);
    const opts = await teacher.gpaRequestOptions(T);
    expect(opts.services).toEqual(expect.arrayContaining([{ key: 'quiz', name: 'Quiz 대비', point: 2 }]));
    expect(await mine(T)).toEqual([{
      serId: SER_GPA, onDate: ON, startMin: 1200, endMin: 1240, title: 'GPA 관리', subKey: null, kindKey: 'gpa',
      students: [{ id: STU, name: '박하경' }],
    }]);
    // 남의 강사에게는 없다 — 쓰기의 404 와 같은 경계
    expect(await mine(OTHER)).toEqual([]);
    // 사이클이 닫혔으면 · 휴강이면 고를 수 없다(쓰기가 409 로 막는 것과 같다)
    await q(`UPDATE gpa_cycle SET closed = true, closed_at = now(), closed_by = $2 WHERE id = $1`, [CYCLE, BOSS]);
    expect(await mine(T)).toEqual([]);
    await q(`UPDATE gpa_cycle SET closed = false, closed_at = NULL, closed_by = NULL WHERE id = $1`, [CYCLE]);
    await q(`UPDATE ser_occ SET canceled = true WHERE ser_id = $1`, [SER_GPA]);
    expect(await mine(T)).toEqual([]);
  });

  it('GPA 회차 요청 — 승인된 GPA 기록은 되돌리지 않는다(409) · 사이클이 닫혔으면 승인도 409', async () => {
    const made = await teacher.createSettingRequest(T, { reqType: 'gpa_request', serId: SER_GPA, onDate: ON, studentId: STU, svcKey: 'quiz' });
    const out = await drawer.reviewRequest(made.id, BOSS, { decision: 'approve' }, false);
    await q(`UPDATE gpa_use SET state = 'ok', approved_by = $2, approved_at = now() WHERE student_id = $1`, [STU, BOSS]);
    await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    expect(await q(`SELECT id FROM gpa_use WHERE student_id = $1`, [STU])).toHaveLength(1);

    await q(`DELETE FROM gpa_use WHERE student_id = $1`, [STU]);
    await q(`DELETE FROM req WHERE id = $1`, [made.id]);
    const again = await teacher.createSettingRequest(T, { reqType: 'gpa_request', serId: SER_GPA, onDate: ON, studentId: STU, svcKey: 'quiz' });
    await q(`UPDATE gpa_cycle SET closed = true, closed_at = now(), closed_by = $2 WHERE id = $1`, [CYCLE, BOSS]);
    await expect(drawer.reviewRequest(again.id, BOSS, { decision: 'approve' }, false)).rejects.toMatchObject({ response: { code: 'CYCLE_CLOSED' } });
    expect((await req(again.id)).state).toBe('pending');
    expect(await logCount('REQ', again.id, 'approve')).toBe(0);
  });

  /* ── ⑥ 감사 — 쓰기마다 한 줄, 막히면 0 줄 (N-73) ──────────────────────────── */

  it('요청 승인 · 반려는 쓰기마다 감사 한 줄 · 이미 처리된 요청(409)은 0 줄', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });
    await drawer.reviewRequest(id, BOSS, { decision: 'reject', reason: '다음 달에' }, true);
    // 감사 낱말은 표의 이름(REQ · 대문자) — 옛 인라인 줄의 소문자 `req` 는 더 쓰지 않는다(W11 A' 후속)
    expect(await logCount('REQ', id, 'reject')).toBe(1);
    expect(await logCount('req', id, 'reject')).toBe(0);
    await expect(drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true)).rejects.toMatchObject({ response: { code: 'REQ_NOT_PENDING' } });
    expect(await logCount('REQ', id, 'approve')).toBe(0);
    expect(await logCount('REQ', id, 'reject')).toBe(1);
  });

  it('변경 요청 반영 · 반려도 한 줄 · 이미 처리된 요청(409)은 0 줄', async () => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO chreq (ser_id,on_date,req_type,payload,reason,by_id) VALUES ($1,$2,'teacher',$4::jsonb,'바꿔 주세요',$3) RETURNING id`,
      [SER_CH, ON, T, JSON.stringify({ teacherId: OTHER })],
    );
    const id = Number(c.id);
    await drawer.reviewChangeRequest(id, BOSS, { decision: 'approve' });
    expect(await logCount('CHREQ', id, 'apply')).toBe(1);
    expect(await logCount('chreq', id, 'apply')).toBe(0);
    await expect(drawer.reviewChangeRequest(id, BOSS, { decision: 'reject', reason: '늦었습니다' }))
      .rejects.toMatchObject({ response: { code: 'CHREQ_NOT_PENDING' } });
    expect(await logCount('CHREQ', id, 'reject')).toBe(0);
  });

  /* ── ⑦ 한 번만 (W11 A' 후속) ────────────────────────────────────────────── */

  it('한 번만 — 되돌린 뒤 같은 결정으로 다시 처리하면 옛 토큰은 409 · 새 토큰만 통한다(요청)', async () => {
    const id = await openReq('tz_change', { from: 'Asia/Seoul', tz: 'America/New_York' });
    const first = await drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true);
    await drawer.undoApproval(BOSS, first.undoToken!, false);
    const second = await drawer.reviewRequest(id, BOSS, { decision: 'approve' }, true);
    // 상태(approved · 같은 사람)만으로는 두 토큰을 못 가른다 — 옛 토큰이 묶인 감사 줄 뒤에 줄이 있다
    await expect(drawer.undoApproval(BOSS, first.undoToken!, false)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    expect((await req(id)).state).toBe('approved');
    expect((await q<{ tz: string }>(`SELECT tz FROM staff WHERE id = $1`, [T]))[0].tz).toBe('America/New_York');
    expect(await logCount('REQ', id, 'undo')).toBe(1);
    await expect(drawer.undoApproval(BOSS, second.undoToken!, false)).resolves.toMatchObject({ reverted: '시간대 되돌림' });
    expect(await logCount('REQ', id, 'undo')).toBe(2);
  });

  it('한 번만 — 변경 요청 반려도 같다(옛 토큰 409 · 새 토큰만)', async () => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO chreq (ser_id,on_date,req_type,payload,reason,by_id) VALUES ($1,$2,'cancel','{}'::jsonb,'쉬어야 합니다',$3) RETURNING id`,
      [SER_CH, ON, T],
    );
    const id = Number(c.id);
    const first = await drawer.reviewChangeRequest(id, BOSS, { decision: 'reject', reason: '대체 강사를 먼저' });
    await drawer.undoApproval(BOSS, first.undoToken!, false);
    const second = await drawer.reviewChangeRequest(id, BOSS, { decision: 'reject', reason: '대체 강사를 먼저' });
    await expect(drawer.undoApproval(BOSS, first.undoToken!, false)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    expect((await q<{ state: string }>(`SELECT state FROM chreq WHERE id = $1`, [id]))[0].state).toBe('rejected');
    await expect(drawer.undoApproval(BOSS, second.undoToken!, false)).resolves.toMatchObject({ reverted: '상태만' });
  });

  /* ── ⑧ 줌 계정 갈래 (W11 A' 후속) ────────────────────────────────────────── */

  describe('줌 계정 갈래 변경 요청 되돌리기', () => {
    const occZacc = async () => (await q<{ zacc_id: string | null }>(
      `SELECT zacc_id FROM ser_occ WHERE ser_id = $1 AND on_date = $2`, [SER_Z, ON]))[0]?.zacc_id ?? null;
    const zoomReq = async () => Number((await q<{ id: string }>(
      `INSERT INTO chreq (ser_id,on_date,req_type,payload,reason,by_id,apply_all) VALUES ($1,$2,'room',$4::jsonb,'계정을 바꿔 주세요',$3,false) RETURNING id`,
      [SER_Z, ON, T, JSON.stringify({ zaccId: Z2 })],
    ))[0].id);

    beforeEach(async () => {
      // 온라인 단발 수업 — 규칙 배정은 Z1(정본 zassign · 투영 ser_occ)
      await q(
        `INSERT INTO ser (id,kind_key,mode,start_min,end_min,rrule,from_date,to_date,teacher_id,title)
         VALUES ($1,'undo_test','online',1080,1140,'ONCE',$2,$2,$3,'줌 되돌림 수업')`, [SER_Z, ON, T],
      );
      await q(`INSERT INTO zassign (ser_id, zacc_id, fixed) VALUES ($1,$2,true)`, [SER_Z, Z1]);
      await q(
        `INSERT INTO ser_occ (ser_id,on_date,teacher_id,zacc_id,span)
         VALUES ($1,$2::date,$3,$4, tstzrange(($2 || ' 18:00+09')::timestamptz, ($2 || ' 19:00+09')::timestamptz, '[)'))`,
        [SER_Z, ON, T, Z1],
      );
    });

    it('반영하면 토큰이 오고 · 되돌리면 앞 배정(Z1)으로 · 배정 때 생긴 예외 줄도 걷힌다 · 요청은 대기로', async () => {
      const id = await zoomReq();
      const out = await drawer.reviewChangeRequest(id, BOSS, { decision: 'approve' });
      expect(out.undoToken).toEqual(expect.any(String));
      expect(Date.parse(out.undoExpiresAt!)).toBeGreaterThan(Date.now());
      expect(await occZacc()).toBe(String(Z2));
      expect(await q(`SELECT id FROM exc WHERE ser_id = $1`, [SER_Z])).toHaveLength(1);

      await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).resolves.toMatchObject({ target: 'chreq', reverted: '줌 계정 되돌림' });
      expect(await occZacc()).toBe(String(Z1));
      expect(await q(`SELECT id FROM exc WHERE ser_id = $1`, [SER_Z])).toHaveLength(0);
      expect(await q<{ ser_id: string | null; zacc_id: string }>(
        `SELECT ser_id, zacc_id FROM zassign WHERE zacc_id = ANY($1)`, [[Z1, Z2]],
      )).toEqual([{ ser_id: String(SER_Z), zacc_id: String(Z1) }]);
      expect((await q<{ state: string }>(`SELECT state FROM chreq WHERE id = $1`, [id]))[0].state).toBe('pending');
      expect(await logCount('CHREQ', id, 'undo')).toBe(1);
      // 같은 토큰 두 번은 없다
      await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
    });

    it('그 사이 다른 배정이 있었으면 409 이고 배정 · 요청은 그대로다', async () => {
      const id = await zoomReq();
      const out = await drawer.reviewChangeRequest(id, BOSS, { decision: 'approve' });
      await zoom.assign(BOSS, { serId: SER_Z, onDate: ON, zaccId: Z1 });
      await expect(drawer.undoApproval(BOSS, out.undoToken!, false)).rejects.toMatchObject({ response: { code: 'UNDO_STALE' } });
      expect(await occZacc()).toBe(String(Z1));
      expect((await q<{ state: string }>(`SELECT state FROM chreq WHERE id = $1`, [id]))[0].state).toBe('approved');
      expect(await logCount('CHREQ', id, 'undo')).toBe(0);
    });
  });
});
