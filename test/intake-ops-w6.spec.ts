/** @file-guide
 * 목적: intake-ops-w6.spec.ts — 상담 카드 「등록 수업」 한 줄 · 카드 단추 줄 · 컴플레인 문의자 관계 · 마무리 날짜 (wave 6 · 23-11 · 23-14 · 67-5 · 67-6) (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 원본 §23 카드 · §67 카드 — 여섯째 물결(wave 6)이 닫은 넷을 HTTP 로 본다(응답 칸이 없으면 **값이 틀려서** 빨갛다).
 *
 *   ① 23-11 등록 카드의 「등록 수업」 한 줄 — 그 학생의 명단(SER_STU)에서 서버가 낱말을 만든다(「SAT Math 주2 · 강사」).
 *      끝난 명단 · 끝난 규칙 · 단발은 빠지고, 격주는 「주N」이라 거짓말하지 않는다. 등록 건이 아니면 null.
 *   ② 23-14 카드 단추 줄 — 단계마다 원본 컷의 단추가 서고, 단계를 옮기는 단추는 **전이표(nextStages) 안에서만** 선다.
 *   ③ 67-5 문의자 관계 — 접수 · 처리에서 적고 지우며, 낱말은 서버 · 모르는 말은 DTO(400) · 서비스(409) · 표(23514)가 막는다.
 *   ④ 67-6 마무리 날짜 — 「결과」로 옮기는 순간 서버가 찍는다(입력 칸 아님). 결과 칸에 머무는 동안 고쳐도 그대로 ·
 *      다시 열면 비운다 · 열린 건에는 표가 날짜를 못 붙게 막는다 · 옛 행은 NULL 그대로(지어내지 않는다 · N-25).
 *
 * ⚠ 제 픽스처만 만들고 지운다 (개발 DB 는 읽기 전용처럼 다룬다 — test/db.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { OpsService } from '../src/modules/ops/ops.service';
import { todayKst } from '../src/lib/kst';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(60_000);

type Row = Record<string, unknown>;

d('상담 카드 · 컴플레인 카드 (wave 6 · 23-11 · 23-14 · 67-5 · 67-6)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  const PW = 'w6-intake-1234';
  const CEO = 16601;
  const TEACHER = 16602;
  const STU = 96611;
  const STU_OTHER = 96612;
  const L = { first: 96621, wait: 96622, waitBare: 96623, second: 96624, hold: 96625, enrolled: 96626, failed: 96627, noStudent: 96628 };
  const SER = { weekly: 96631, ended: 96632, biweekly: 96633, once: 96634, closedRule: 96635 };
  const BODY = 'W6 문의자 관계 시험';
  const TODAY = todayKst();
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);

  const q = <T = Row>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'get' | 'post' | 'patch', path: string) =>
    request(app.getHttpServer())[m](path).set('Authorization', `Bearer ${token}`).timeout({ response: 10000, deadline: 20000 });
  const ops = async () => (await api('get', '/ops').expect(200)).body as { leads: Row[]; complaints: Row[]; cplRequesters?: Row[] };
  const leadOf = (body: { leads: Row[] }, id: number) => body.leads.find((l) => l.id === id)!;
  const cplIds = async () => (await q<{ id: string }>(`SELECT id FROM cpl WHERE body LIKE $1`, [`${BODY}%`])).map((r) => Number(r.id));

  async function cleanup() {
    const leads = Object.values(L);
    const cpls = await cplIds();
    if (cpls.length) await q(`DELETE FROM log WHERE entity = 'CPL' AND entity_id = ANY($1)`, [cpls]);
    await q(`DELETE FROM cpl WHERE body LIKE $1`, [`${BODY}%`]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [Object.values(SER)]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [Object.values(SER)]);
    await q(`DELETE FROM lead_appt WHERE lead_id = ANY($1)`, [leads]);
    await q(`DELETE FROM lead_touch WHERE lead_id = ANY($1)`, [leads]);
    await q(`DELETE FROM lead_stage_log WHERE lead_id = ANY($1)`, [leads]);
    await q(`DELETE FROM lead WHERE id = ANY($1)`, [leads]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU, STU_OTHER]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, TEACHER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await cleanup();

    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'W6대표','w6-intake-ceo@t.kr','ceo',$3,true),
         ($2,'W6강사','w6-intake-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    await q(`INSERT INTO stu (id, name, grade, school) VALUES ($1,'W6학생','8','테스트중'), ($2,'W6둘째','9','테스트중')`, [STU, STU_OTHER]);
    // 그 학생의 명단 — 지금 다니는 주2 · 끝난 명단 · 격주 · 단발 · 끝난 규칙
    await q(
      `INSERT INTO ser (id, kind_key, sub_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date) VALUES
         ($1,'class','sat-math',$6,'offline',1020,1110,'WEEKLY:MO,WE',$7::date,NULL),
         ($2,'class','writing',$6,'offline',1020,1110,'WEEKLY:TU',$7::date,NULL),
         ($3,'class','map-read',$6,'offline',600,690,'WEEKLY:SA/2',$7::date,NULL),
         ($4,'class','writing',$6,'offline',600,690,'ONCE',$8::date,$8::date),
         ($5,'class','map-read',$6,'offline',600,690,'WEEKLY:TH',$7::date,$9::date)`,
      [SER.weekly, SER.ended, SER.biweekly, SER.once, SER.closedRule, TEACHER, plus(TODAY, -30), plus(TODAY, 3), plus(TODAY, -2)],
    );
    await q(
      `INSERT INTO ser_stu (ser_id, student_id, to_date) VALUES ($1,$6,NULL), ($2,$6,$7::date), ($3,$6,NULL), ($4,$6,NULL), ($5,$6,NULL)`,
      [SER.weekly, SER.ended, SER.biweekly, SER.once, SER.closedRule, STU, plus(TODAY, -1)],
    );
    await q(
      `INSERT INTO lead (id, name, stage, student_id, owner_id, stop_at, fail_from) VALUES
         ($1,'W6일차','first',NULL,$9,NULL,NULL),
         ($2,'W6대기','wait2nd',NULL,$9,NULL,NULL),
         ($3,'W6대기빈','wait2nd',NULL,$9,NULL,NULL),
         ($4,'W6이차','second',NULL,$9,NULL,NULL),
         ($5,'W6보류','hold',NULL,$9,NULL,NULL),
         ($6,'W6등록','enrolled',$10,$9,NULL,NULL),
         ($7,'W6실패','failed',NULL,$9,'after_first','first'),
         ($8,'W6등록빈','enrolled',NULL,$9,NULL,NULL)`,
      [L.first, L.wait, L.waitBare, L.second, L.hold, L.enrolled, L.failed, L.noStudent, CEO, STU],
    );
    // 2차 대기 한 건에는 아직 시간표에 안 만든 2차 일정이 있다 — 「스케줄에 1건 만들기」가 서는 조건
    await q(
      `INSERT INTO lead_appt (lead_id, kind, on_date, start_min, end_min, mode, created_by) VALUES ($1,'second',$2::date,870,930,'offline',$3)`,
      [L.wait, plus(TODAY, 5), CEO],
    );
    token = (await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ loginId: 'w6-intake-ceo@t.kr', password: PW }).expect(201)).body.accessToken as string;
  });

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  /* ══ 23-11 등록 수업 한 줄 ══════════════════════════════════════════════════════ */

  it('① 등록 카드의 「등록 수업」은 그 학생의 지금 명단에서 서버가 만든다 — 원본 「과목 주N · 강사」 · 격주는 규칙 낱말 · 끝난 명단/규칙 · 단발은 빠진다 (23-11)', async () => {
    const body = await ops();
    expect(leadOf(body, L.enrolled).lessons).toEqual(['SAT Math 주2 · W6강사', 'MAP Reading 2주마다 토 · W6강사']);
    // 등록 건이 아니거나 학생이 안 붙었으면 줄 자체가 없다 — 「없음」을 지어내지 않는다
    expect(leadOf(body, L.noStudent).lessons).toBeNull();
    expect(leadOf(body, L.second).lessons).toBeNull();
  });

  /* ══ 23-14 카드 단추 줄 ═════════════════════════════════════════════════════════ */

  it('② 카드 단추 줄은 단계마다 원본 컷의 단추이고 낱말은 서버 것이다 — 없는 동작(카드 작성)은 서지 않는다 (23-14)', async () => {
    const body = await ops();
    const actions = (id: number) => (leadOf(body, id).cardActions as Row[]).map((a) => [a.key, a.label, a.to ?? null]);
    expect(actions(L.first)).toEqual([['appt', '2차 · 진단 잡기', null], ['enroll', '바로 등록', null], ['fail', '여기서 종료', null]]);
    expect(actions(L.wait)).toEqual([['schedule', '스케줄에 1건 만들기', null], ['move', '2차 진행', 'second']]);
    // 시간표에 만들 일정이 없으면 「스케줄에 N건 만들기」는 서지 않는다 — 서버가 409 LEAD_APPT_NONE 으로 막는 그 조건
    expect(actions(L.waitBare)).toEqual([['move', '2차 진행', 'second']]);
    expect(actions(L.second)).toEqual([['move', '보류', 'hold'], ['enroll', '등록', null], ['fail', '실패', null]]);
    expect(actions(L.hold)).toEqual([['enroll', '등록', null], ['fail', '실패', null], ['extend', '연장 +2일', null]]);
    expect(actions(L.enrolled)).toEqual([['touch', '사후 관리', null]]);
    expect(actions(L.failed)).toEqual([['detail', '내역 · 상태', null], ['resume', '되살리기', null]]);
  });

  it('② 단계를 옮기는 단추는 전이표(nextStages) 밖으로 나가지 않는다 — 카드가 새 전이를 만들지 않는다 (23-14)', async () => {
    const body = await ops();
    for (const lead of body.leads) {
      const next = (lead.nextStages as Row[]).map((s) => s.key);
      for (const a of (lead.cardActions as Row[] | undefined) ?? []) {
        if (a.key === 'move') expect(next).toContain(a.to);
      }
    }
    // 단추 줄의 「2차 진행」을 누른 것과 같은 요청 — 전이표 그대로 통과하고 카드가 다음 칸의 단추로 바뀐다
    const moved = (await api('patch', `/ops/leads/${L.waitBare}/stage`).send({ to: 'second' }).expect(200)).body as Row;
    expect((moved.cardActions as Row[]).map((a) => a.key)).toEqual(['move', 'enroll', 'fail']);
  });

  /* ══ 67-5 문의자 관계 ════════════════════════════════════════════════════════════ */

  it('③ 문의자 관계 — 접수에 적고 처리에서 바꾸고 비운다 · 낱말은 서버의 둘(원본 §67 「어머니」 · §29 「누가 요청」과 같은 말) (67-5)', async () => {
    const body = await ops();
    expect(body.cplRequesters).toEqual([{ key: 'mother', label: '어머니' }, { key: 'father', label: '아버지' }]);

    const made = (await api('post', '/ops/complaints').send({ area: 'lesson', studentId: STU, body: `${BODY} 접수`, requester: 'mother' }).expect(201)).body as Row;
    expect(made.requester).toBe('mother');
    expect(made.requesterLabel).toBe('어머니');

    const changed = (await api('patch', `/ops/complaints/${made.id}`).send({ requester: 'father' }).expect(200)).body as Row;
    expect(changed.requesterLabel).toBe('아버지');
    const cleared = (await api('patch', `/ops/complaints/${made.id}`).send({ requester: null }).expect(200)).body as Row;
    expect(cleared.requester).toBeNull();
    expect(cleared.requesterLabel).toBeNull();
    // 모르고 적지 않은 건(옛 행 · 비운 건)은 null 그대로 — 화면이 「미정」을 짓지 않는다
    const plain = (await api('post', '/ops/complaints').send({ area: 'book', body: `${BODY} 모름` }).expect(201)).body as Row;
    expect(plain.requester).toBeNull();
    expect(plain.requesterLabel).toBeNull();
  });

  it('③ 모르는 관계는 DTO(400) · 서비스(409) · 표의 CHECK(23514) 세 겹이 막는다 (67-5)', async () => {
    await api('post', '/ops/complaints').send({ area: 'lesson', body: `${BODY} 거절`, requester: 'aunt' }).expect(400);
    const [one] = await cplIds();
    await api('patch', `/ops/complaints/${one}`).send({ requester: 'aunt' }).expect(400);
    // DTO 를 건너뛴 호출도 서비스가 다시 본다
    const svc = app.get(OpsService);
    await expect(svc.createComplaint(CEO, false, { area: 'lesson', body: `${BODY} 서비스`, requester: 'aunt' } as never))
      .rejects.toMatchObject({ response: { code: 'CPL_REQUESTER_INVALID' } });
    await expect(svc.patchComplaint(CEO, false, one, { requester: 'aunt' } as never))
      .rejects.toMatchObject({ response: { code: 'CPL_REQUESTER_INVALID' } });
    // 표가 마지막으로 막는다
    await expect(q(`INSERT INTO cpl (area, stage, body, requester) VALUES ('lesson','received',$1,'aunt')`, [`${BODY} 표`]))
      .rejects.toMatchObject({ code: '23514' });
  });

  /* ══ 67-6 마무리 날짜 ════════════════════════════════════════════════════════════ */

  it('④ 마무리 날짜는 「결과」로 옮기는 순간 서버가 찍는다 — 머무는 동안 고쳐도 그대로 · 다시 열면 비운다 (67-6)', async () => {
    const made = (await api('post', '/ops/complaints').send({ area: 'teacher', body: `${BODY} 마무리`, ownerId: CEO }).expect(201)).body as Row;
    expect(made.closedOn).toBeNull();
    // 받는 칸이 아니다 — 날짜를 보내면 DTO 가 막는다(모르는 칸)
    await api('patch', `/ops/complaints/${made.id}`).send({ closedOn: '2026-08-12' }).expect(400);

    const closed = (await api('patch', `/ops/complaints/${made.id}`).send({ stage: 'closed', result: '강사 교체로 마무리' }).expect(200)).body as Row;
    expect(closed.closedOn).toBe(TODAY);

    // 결과 칸에 머무는 동안 글을 고쳐도 마무리 날짜는 그 순간 그대로다 — 옛 날짜로 되돌려 두고 확인한다
    await q(`UPDATE cpl SET closed_at = '2026-08-12T10:00:00+09:00' WHERE id = $1`, [made.id]);
    const edited = (await api('patch', `/ops/complaints/${made.id}`).send({ result: '강사 교체 · 학부모 통화 완료' }).expect(200)).body as Row;
    expect(edited.closedOn).toBe('2026-08-12');

    // 다시 열면(대응으로) 마무리 날짜를 비운다 — 끝나지 않은 건이 마무리 날짜를 들고 있으면 거짓이다
    const reopened = (await api('patch', `/ops/complaints/${made.id}`).send({ stage: 'acting' }).expect(200)).body as Row;
    expect(reopened.closedOn).toBeNull();
    // 표도 막는다 — 열린 건에 마무리 날짜
    await expect(q(`UPDATE cpl SET closed_at = now() WHERE id = $1`, [made.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('④ 옛 「결과」 행(마무리 시각 모름)은 null 그대로다 — 접수일로 짓지 않는다 (N-25 · 67-6)', async () => {
    await q(`INSERT INTO cpl (area, stage, body, result, created_at) VALUES ('lesson','closed',$1,'옛 결과','2026-07-01T00:00:00Z')`, [`${BODY} 옛 행`]);
    const body = await ops();
    const old = body.complaints.find((c) => c.body === `${BODY} 옛 행`);
    // 월별 기간 안에 없을 수 있다 — 전체 목록(기간 없음)으로 본다
    expect(old === undefined || old.closedOn === null).toBe(true);
    const [row] = await q<{ id: string }>(`SELECT id FROM cpl WHERE body = $1`, [`${BODY} 옛 행`]);
    const one = (await api('patch', `/ops/complaints/${row.id}`).send({ requester: 'mother' }).expect(200)).body as Row;
    expect(one.closedOn).toBeNull();
    expect(one.requesterLabel).toBe('어머니');
  });
});
