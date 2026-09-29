/** @file-guide
 * 목적: crosscut-chreq-perm-http.spec.ts — P1 CROSS-CUT 권한 전수가 찾은 옆문: 결재 권한만 켠 강사가 §20 변경 요청으로 남의 시간표를 바꾸는 길
 * 책임/재사용: 실제 AppModule · 가드 · JWT 로 HTTP 를 부르고 DB 를 다시 읽는다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md · docs/report/GO-LIVE-GAP-2026-09-29.md §5-2
 */

/**
 * 시간표를 바꾸는 쓰기(`/schedule` 쓰기 전부)는 `canCrudAll` 을 요구한다. 그런데 §20 변경 요청 **반영**은 `@Perm('canApprove')` 하나만
 * 봤고, 반영은 같은 일정 쓰기(patch · remove)를 그대로 탄다 — 그래서 사람별 예외로 **결재 권한만 켠 강사**(N-68 · 매니저가 줄 수 있다)가
 * 남의 수업을 옮기고 · 강사를 바꾸고 · 휴강시킬 수 있었다. 문이 둘인데 한쪽만 잠긴 모양이다(S2 · S4 와 같다).
 *
 * 증명하는 것 —
 *   ① 결재 권한만 켠 강사의 반영 · 반려는 403 `CHREQ_REVIEW_FORBIDDEN` 이고 요청 · 회차가 그대로다.
 *   ② 같은 사람의 서랍 §14 줄은 단추가 서지 않고(canAct false) 막힌 이유가 403 과 같은 문장이다(D-R39).
 *   ③ 변경 요청 처리의 되돌리기 토큰을 그 사람이 들고 와도 403 이다(시간표를 되돌리는 쓰기).
 *   ④ 전체 편집 권한이 있는 관리자는 그대로 반영된다(열린 자리는 열려 있다).
 *
 * ⚠ 제 픽스처만 만들고 지운다(전역 DELETE 없음). 반영 성공(④)은 시드 회차 하나를 휴강시키므로 **제품의 되돌리기**로 원래대로 돌린다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { issueApprovalUndo } from '../src/modules/drawer/approval-undo';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('P1 CROSS-CUT — 결재 권한만으로는 §20 변경 요청을 반영 · 반려하지 못한다 (HTTP)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 'crosscut-chreq-1234';
  const ADMIN = 1711;
  const APPROVER = 1712; // 강사 + can_approve=true
  const REQUESTER = 1713; // 강사 — 요청을 올린 사람
  const tok: Record<string, string> = {};
  let serId = 0;
  let onDate = '';
  let chreqId = 0;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'post' | 'get', p: string, t: string) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 8000, deadline: 15000 });
  const chreqState = async () => (await q<{ state: string }>(`SELECT state FROM chreq WHERE id = $1`, [chreqId]))[0]?.state;
  const occ = async () => (await q<{ canceled: boolean; teacher_id: string | null }>(
    `SELECT canceled, teacher_id FROM ser_occ WHERE ser_id = $1 AND on_date = $2`, [serId, onDate],
  ))[0];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    const ids = [ADMIN, APPROVER, REQUESTER];
    await q(`DELETE FROM chreq WHERE by_id = ANY($1)`, [ids]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_approve) VALUES
         ($1,'교차관리자','xc-admin@t.kr','admin',$4,true,NULL),
         ($2,'교차결재강사','xc-approver@t.kr','teacher',$4,true,true),
         ($3,'교차요청강사','xc-req@t.kr','teacher',$4,true,NULL)`,
      [ADMIN, APPROVER, REQUESTER, hash],
    );
    // 앞으로 올 · 취소되지 않은 회차 하나 — 반영이 실제로 시간표를 바꾸는지 본다
    const [o] = await q<{ ser_id: string; on_date: string }>(
      `SELECT ser_id, to_char(on_date,'YYYY-MM-DD') AS on_date FROM ser_occ
        WHERE NOT canceled AND lower(span) > now() + interval '2 days' ORDER BY lower(span) LIMIT 1`,
    );
    serId = Number(o.ser_id);
    onDate = o.on_date;
    const [c] = await q<{ id: string }>(
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id, apply_all)
       VALUES ($1,$2,'cancel','{}'::jsonb,'교차 검사 — 휴강 요청',$3,false) RETURNING id`,
      [serId, onDate, REQUESTER],
    );
    chreqId = Number(c.id);
    const login = async (email: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId: email, password: PW }).expect(201)).body.accessToken as string;
    tok.admin = await login('xc-admin@t.kr');
    tok.approver = await login('xc-approver@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        const ids = [ADMIN, APPROVER, REQUESTER];
        await q(`DELETE FROM chreq WHERE by_id = ANY($1) OR id = $2`, [ids, chreqId]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
      }
    } finally {
      await app?.close();
    }
  });

  it('① 결재 권한만 켠 강사의 반영 · 반려는 403 CHREQ_REVIEW_FORBIDDEN — 요청 · 회차가 그대로다', async () => {
    const before = await occ();
    const approve = await api('post', `/drawer/change-requests/${chreqId}/review`, tok.approver).send({ decision: 'approve' });
    expect(approve.status).toBe(403);
    expect(approve.body.code).toBe('CHREQ_REVIEW_FORBIDDEN');
    const reject = await api('post', `/drawer/change-requests/${chreqId}/review`, tok.approver).send({ decision: 'reject', reason: '안 됩니다' });
    expect(reject.status).toBe(403);
    expect(reject.body.code).toBe('CHREQ_REVIEW_FORBIDDEN');
    expect(await chreqState()).toBe('pending');
    expect(await occ()).toEqual(before);
  });

  it('② 같은 사람의 서랍 §14 줄에는 단추가 서지 않고, 막힌 이유가 403 과 같은 문장이다 (D-R39)', async () => {
    const res = await api('get', '/drawer', tok.approver).expect(200);
    const rows = [...res.body.approvals.waiting, ...res.body.approvals.inbox] as Array<{ kind: string; id: number; canAct?: boolean; actBlockedReason?: string | null }>;
    const mine = rows.filter((r) => r.kind === 'chreq' && r.id === chreqId);
    expect(mine.length).toBeGreaterThan(0);
    const refused = await api('post', `/drawer/change-requests/${chreqId}/review`, tok.approver).send({ decision: 'approve' });
    for (const r of mine) {
      expect(r.canAct).toBe(false);
      expect(r.actBlockedReason).toBe(refused.body.message);
    }
  });

  it('③ 변경 요청 처리의 되돌리기 토큰을 들고 와도 403 — 시간표를 되돌리는 쓰기다', async () => {
    const { token } = issueApprovalUndo(APPROVER, { target: 'chreq', id: chreqId, decision: 'reject', logId: 1, schedToken: null });
    const res = await api('post', '/drawer/approvals/undo', tok.approver).send({ token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CHREQ_REVIEW_FORBIDDEN');
    expect(await chreqState()).toBe('pending');
  });

  it('④ 전체 편집 권한이 있는 관리자는 그대로 반영되고 되돌릴 수 있다 — 회차가 휴강으로 바뀌었다 돌아온다', async () => {
    const before = await occ();
    const res = await api('post', `/drawer/change-requests/${chreqId}/review`, tok.admin).send({ decision: 'approve' });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('approved');
    expect(await chreqState()).toBe('approved');
    expect((await occ())?.canceled).toBe(true);
    const undo = await api('post', '/drawer/approvals/undo', tok.admin).send({ token: res.body.undoToken });
    expect(undo.status).toBe(201);
    expect(await chreqState()).toBe('pending');
    expect(await occ()).toEqual(before);
  });
});
