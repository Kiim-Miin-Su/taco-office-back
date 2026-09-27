/** @file-guide
 * 목적: guardians-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 보호자 · 선택 발송 — DQ3 대표 답변 (2026-09-25 · N-42): 「복수 보호자 + 선택 발송, 메일과 SENS 만」.
 *
 * 증명하는 것 —
 *   ① 보호자 CRUD — 휴대폰은 숫자만 저장 · 첫 보호자가 대표 · 연락처를 비우면 그 채널 받기도 꺼짐 · 삭제는 사용 중지(행은 남는다).
 *   ② 대표는 학생당 하나 — 새 대표를 세우면 전 대표가 내려가고, 직접 SQL 두 번째 대표는 부분 유니크가 막는다.
 *   ③ 연락처는 최소 하나 — 서비스 400 과 DB CHECK 둘 다. 메일·휴대폰 모양은 DTO 가 막는다.
 *   ④ 강사(canAdminPage·canCrudAll 없음)는 어느 길도 못 쓴다 — 연락처가 강사에게 내려가지 않는다.
 *   ⑤ 설정 없음 — 발송기를 부르지 않고 not_configured 로 원장에 남기며 PNOTI.sent_at 을 찍지 않는다.
 *   ⑥ 실제 발송(가짜 준비된 발송기) — sent 로 남고 PNOTI.sent_at·channel 이 찍힌다. 받는 곳은 가린 값만 남는다.
 *   ⑦ 같은 requestKey 는 다시 보내지 않고 앞선 결과를 돌려준다 · 다른 학생에게 쓴 키는 409.
 *   ⑧ 거절 — 남의 학생 보호자 · 사용 중지한 보호자 · 남의 PNOTI · 받지 않는 채널만 고름.
 *   ⑨ 공급자 오류 문장의 받는 곳 원문은 원장에 가려서 남는다 · LOG 에 연락처 원문이 없다.
 *
 * 발송기는 `SENDER` 를 가짜로 갈아 끼운다 — 실제 SMTP·SENS 로 나가지 않는다.
 * ⚠ 이 파일은 **표를 비우지 않는다.** 스위트 전용 번호대로 만들고 스스로 치운다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { SENDER } from '../src/modules/notify/sender';
import { FakeSender } from './fake-sender';
import { blockedBy, DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('보호자 · 선택 발송 (DQ3 · N-42)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const fake = new FakeSender();
  const PW = 'guardian-spec-1234';
  const CEO = 951;
  const TEACHER = 952;
  const STU_A = 9951;
  const STU_B = 9952;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  const cleanRows = async () => {
    await q(`DELETE FROM guardian_send WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`DELETE FROM guardian WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`DELETE FROM pnoti WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`DELETE FROM log WHERE actor_id = $1`, [CEO]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SENDER).useValue(fake)
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await cleanRows();
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'보호자대표','guardian-ceo@t.kr','ceo',$3,true),
         ($2,'보호자강사','guardian-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'보호자학생A','10'), ($2,'보호자학생B','10')`, [STU_A, STU_B]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId: email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('guardian-ceo@t.kr');
    teacherToken = await login('guardian-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanRows();
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
      }
    } finally {
      await app?.close();
    }
  });

  beforeEach(() => {
    fake.readyMap = { email: false, sms: false };
    fake.reply = () => ({ configured: true, ok: true, providerId: 'fake-1', error: null });
    fake.calls = [];
  });
  afterEach(cleanRows);

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 5000, deadline: 10000 });

  const addGuardian = (studentId: number, body: Record<string, unknown>) =>
    api('post', `/students/${studentId}/guardians`).send(body);

  const parentNotice = async (studentId: number) => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO pnoti (audience, student_id, channel, body) VALUES ('parent', $1, 'app', '오늘 수업 안내') RETURNING id`,
      [studentId],
    );
    return Number(row.id);
  };

  it('① 추가·목록·고치기·사용 중지 — 휴대폰은 숫자만, 첫 보호자는 대표, 삭제는 행을 남긴다', async () => {
    const mom = await addGuardian(STU_A, {
      name: ' 김엄마 ', relation: '어머니', email: 'mom@example.com', phone: '010-0000-0001', receiveSms: true,
    }).expect(201);
    expect(mom.body).toMatchObject({
      studentId: STU_A, name: '김엄마', relation: '어머니', email: 'mom@example.com',
      phone: '01000000001', phoneDisplay: '010-0000-0001', receiveEmail: true, receiveSms: true,
      receives: ['email', 'sms'], isPrimary: true, active: true,
    });
    const dad = await addGuardian(STU_A, { name: '김아빠', relation: '아버지', phone: '01000000002', receiveSms: true }).expect(201);
    // 메일 주소가 없으면 메일 받기는 기본으로 꺼져 있다 · 대표는 이미 있으므로 아니다
    expect(dad.body).toMatchObject({ receiveEmail: false, receiveSms: true, receives: ['sms'], isPrimary: false });

    const list = await api('get', `/students/${STU_A}/guardians`).expect(200);
    expect(list.body.studentName).toBe('보호자학생A');
    expect(list.body.guardians.map((g: { name: string }) => g.name)).toEqual(['김엄마', '김아빠']);

    // 메일 주소를 비우면 메일 받기도 꺼진다 · 빈 글자는 「없음」이다
    const patched = await api('patch', `/guardians/${mom.body.id}`).send({ email: '', relation: '보호자' }).expect(200);
    expect(patched.body).toMatchObject({ email: null, receiveEmail: false, receiveSms: true, receives: ['sms'], relation: '보호자' });

    const off = await api('delete', `/guardians/${dad.body.id}`).expect(200);
    expect(off.body).toMatchObject({ active: false, isPrimary: false });
    const [kept] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM guardian WHERE id = $1`, [dad.body.id]);
    expect(kept.n).toBe(1);
    // 사용 중지한 사람은 「다시 쓰기」 없이는 못 고친다
    await api('patch', `/guardians/${dad.body.id}`).send({ name: '고침' }).expect(409);
    const back = await api('patch', `/guardians/${dad.body.id}`).send({ active: true }).expect(200);
    expect(back.body.active).toBe(true);

    // LOG — 누가 무엇을 했는지는 남고 연락처 원문은 없다
    const logs = await q<{ action: string; body: string }>(
      `SELECT action, coalesce(before::text,'') || coalesce(after::text,'') AS body FROM log WHERE actor_id = $1 AND entity = 'GUARDIAN' ORDER BY id`,
      [CEO],
    );
    expect(logs.map((l) => l.action)).toEqual(['create', 'create', 'update', 'deactivate', 'reactivate']);
    for (const l of logs) {
      expect(l.body).not.toContain('mom@example.com');
      expect(l.body).not.toContain('01000000001');
      expect(l.body).not.toContain('01000000002');
    }
    expect(logs[0].body).toContain('mo***@example.com');
  });

  it('② 대표는 학생당 하나 — 새 대표가 서면 전 대표가 내려가고, DB 가 직접 SQL 도 막는다', async () => {
    const a = await addGuardian(STU_A, { name: '가', email: 'a1@example.com' }).expect(201);
    const b = await addGuardian(STU_A, { name: '나', email: 'b1@example.com', isPrimary: true }).expect(201);
    expect(b.body.isPrimary).toBe(true);
    const rows = await q<{ id: string; is_primary: boolean }>(`SELECT id, is_primary FROM guardian WHERE student_id = $1 ORDER BY id`, [STU_A]);
    expect(rows.map((r) => [Number(r.id), r.is_primary])).toEqual([[a.body.id, false], [b.body.id, true]]);

    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const msg = await blockedBy(runner,
        `INSERT INTO guardian (student_id, name, email, is_primary, created_by) VALUES ($1,'다','c1@example.com',true,$2)`,
        [STU_A, CEO]);
      expect(msg).toContain('guardian_one_primary');
      // 다른 학생의 대표는 막지 않는다
      await runner.query(
        `INSERT INTO guardian (student_id, name, email, is_primary, created_by) VALUES ($1,'라','d1@example.com',true,$2)`,
        [STU_B, CEO],
      );
      // 사용 중지한 사람은 대표일 수 없다
      const msg2 = await blockedBy(runner,
        `INSERT INTO guardian (student_id, name, email, is_primary, active, created_by) VALUES ($1,'마','e1@example.com',true,false,$2)`,
        [STU_B, CEO]);
      expect(msg2).toContain('guardian_primary_active');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('③ 연락처는 최소 하나 — 서비스 400 · DB CHECK · DTO 모양 검사', async () => {
    const none = await addGuardian(STU_A, { name: '연락처없음' }).expect(400);
    expect(none.body.code).toBe('GUARDIAN_CONTACT_REQUIRED');
    const noPhone = await addGuardian(STU_A, { name: '문자만', email: 'x@example.com', receiveSms: true }).expect(400);
    expect(noPhone.body.code).toBe('GUARDIAN_CHANNEL_CONTACT');
    const badMail = await addGuardian(STU_A, { name: '메일틀림', email: 'not-an-email' }).expect(400);
    expect(badMail.body.message).toContain('메일 주소 모양이 아닙니다');
    const badPhone = await addGuardian(STU_A, { name: '번호틀림', phone: '1234' }).expect(400);
    expect(badPhone.body.message).toContain('휴대폰 번호 모양이 아닙니다');
    await api('post', `/students/99999999/guardians`).send({ name: '없는학생', email: 'n@example.com' }).expect(404);

    // 하나 남은 연락처를 PATCH 로 비워도 막힌다
    const only = await addGuardian(STU_A, { name: '메일만', email: 'only@example.com' }).expect(201);
    const cleared = await api('patch', `/guardians/${only.body.id}`).send({ email: null }).expect(400);
    expect(cleared.body.code).toBe('GUARDIAN_CONTACT_REQUIRED');

    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const msg = await blockedBy(runner,
        `INSERT INTO guardian (student_id, name, receive_email, created_by) VALUES ($1,'없음',false,$2)`, [STU_A, CEO]);
      expect(msg).toContain('guardian_contact_present');
      const msg2 = await blockedBy(runner,
        `INSERT INTO guardian (student_id, name, phone, receive_email, created_by) VALUES ($1,'번호','010-1234',false,$2)`, [STU_A, CEO]);
      expect(msg2).toContain('guardian_phone_digits');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('④ 강사는 어느 길도 못 쓴다 — 연락처가 강사에게 내려가지 않는다', async () => {
    const g = await addGuardian(STU_A, { name: '보호자', email: 'p@example.com' }).expect(201);
    await api('get', `/students/${STU_A}/guardians`, teacherToken).expect(403);
    await api('post', `/students/${STU_A}/guardians`, teacherToken).send({ name: 'x', email: 'x@example.com' }).expect(403);
    await api('patch', `/guardians/${g.body.id}`, teacherToken).send({ name: 'x' }).expect(403);
    await api('delete', `/guardians/${g.body.id}`, teacherToken).expect(403);
    await api('get', `/guardians/channels`, teacherToken).expect(403);
    await api('post', `/guardians/send`, teacherToken)
      .send({ studentId: STU_A, guardianIds: [g.body.id], channels: ['email'], body: 'x', requestKey: randomUUID() })
      .expect(403);
    expect(fake.calls).toHaveLength(0);
  });

  it('⑤ 설정 없음 — 발송기를 부르지 않고 not_configured 로 남기며 PNOTI 는 「보낼 것」 그대로다', async () => {
    const g = await addGuardian(STU_A, { name: '김엄마', relation: '어머니', email: 'mom@example.com', phone: '01000000001', receiveSms: true }).expect(201);
    const pnotiId = await parentNotice(STU_A);
    const channels = await api('get', '/guardians/channels').expect(200);
    expect(channels.body.channels).toEqual([
      expect.objectContaining({ channel: 'email', label: '메일', ready: false, reason: expect.stringContaining('설정') }),
      expect.objectContaining({ channel: 'sms', label: '문자', ready: false }),
    ]);

    const res = await api('post', '/guardians/send')
      .send({ studentId: STU_A, pnotiId, guardianIds: [g.body.id], channels: ['sms', 'email'], body: '안내 본문', requestKey: randomUUID() })
      .expect(200);
    expect(fake.calls).toHaveLength(0);
    expect(res.body.counts).toEqual({ sent: 0, failed: 0, notConfigured: 2, skipped: 0 });
    // 채널 순서는 서버 배열 순서다(메일 → 문자)
    expect(res.body.items.map((i: { channel: string; status: string; statusLabel: string; toMasked: string }) => [i.channel, i.status, i.statusLabel, i.toMasked])).toEqual([
      ['email', 'not_configured', '설정 없음 — 보내지 않았습니다', 'mo***@example.com'],
      ['sms', 'not_configured', '설정 없음 — 보내지 않았습니다', '010-****-0001'],
    ]);
    expect(res.body.pnotiSentAt).toBeNull();
    const [p] = await q<{ sent_at: string | null; channel: string }>(`SELECT sent_at, channel FROM pnoti WHERE id = $1`, [pnotiId]);
    expect(p).toEqual({ sent_at: null, channel: 'app' });
    const ledger = await q<{ status: string; to_masked: string }>(`SELECT status, to_masked FROM guardian_send WHERE student_id = $1`, [STU_A]);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((r) => r.status === 'not_configured')).toBe(true);
  });

  it('⑥⑦ 실제 발송 — sent 로 남고 PNOTI 가 찍힌다 · 같은 키는 다시 보내지 않는다 · 다른 학생에게 쓴 키는 409', async () => {
    fake.readyMap = { email: true, sms: true };
    const mom = await addGuardian(STU_A, { name: '김엄마', email: 'mom@example.com', phone: '01000000001', receiveSms: true }).expect(201);
    const dad = await addGuardian(STU_A, { name: '김아빠', email: 'dad@example.com' }).expect(201);
    const pnotiId = await parentNotice(STU_A);
    const requestKey = randomUUID();
    const body = { studentId: STU_A, pnotiId, guardianIds: [mom.body.id, dad.body.id], channels: ['email', 'sms'], body: '오늘 수업 안내', requestKey };

    const first = await api('post', '/guardians/send').send(body).expect(200);
    // 아빠는 문자를 받지 않는다 — 건너뛰고 원장에 줄이 없다
    expect(first.body.counts).toEqual({ sent: 3, failed: 0, notConfigured: 0, skipped: 1 });
    expect(first.body.skipped).toEqual([expect.objectContaining({ guardianId: dad.body.id, channel: 'sms', reason: '문자를 받지 않는 보호자입니다' })]);
    expect(first.body.items).toHaveLength(3);
    expect(fake.calls.map((c) => [c.channel, c.to, c.subject])).toEqual([
      ['email', 'mom@example.com', '보호자학생A 학생 안내'],
      ['sms', '01000000001', '보호자학생A 학생 안내'],
      ['email', 'dad@example.com', '보호자학생A 학생 안내'],
    ]);
    expect(first.body.replayed).toBe(false);
    expect(first.body.pnotiSentAt).toEqual(expect.stringMatching(/\+09:00$/));
    const [p] = await q<{ sent_at: string | null; channel: string }>(`SELECT sent_at, channel FROM pnoti WHERE id = $1`, [pnotiId]);
    expect(p.sent_at).not.toBeNull();
    expect(p.channel).toBe('email');

    // 원장에는 가린 받는 곳만 있다
    const ledger = await q<{ to_masked: string }>(`SELECT to_masked FROM guardian_send WHERE request_key = $1 ORDER BY id`, [requestKey]);
    expect(ledger.map((r) => r.to_masked)).toEqual(['mo***@example.com', '010-****-0001', 'da***@example.com']);
    const [sendLog] = await q<{ after: string }>(`SELECT after::text AS after FROM log WHERE actor_id = $1 AND entity = 'GUARDIAN_SEND'`, [CEO]);
    expect(sendLog.after).not.toContain('mom@example.com');
    expect(sendLog.after).not.toContain('01000000001');

    // 같은 키 — 새로 보내지 않고 같은 결과
    const again = await api('post', '/guardians/send').send(body).expect(200);
    expect(fake.calls).toHaveLength(3);
    expect(again.body.replayed).toBe(true);
    expect(again.body.items).toEqual(first.body.items);
    const [n] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM guardian_send WHERE request_key = $1`, [requestKey]);
    expect(n.n).toBe(3);

    // 같은 키를 다른 학생에게 — 409
    const other = await addGuardian(STU_B, { name: '남', email: 'other@example.com' }).expect(201);
    const reused = await api('post', '/guardians/send')
      .send({ studentId: STU_B, guardianIds: [other.body.id], channels: ['email'], body: 'x', requestKey })
      .expect(409);
    expect(reused.body.code).toBe('REQUEST_KEY_REUSED');
  });

  it('⑧ 거절 — 남의 학생 보호자 · 사용 중지 · 남의 PNOTI · 받지 않는 채널만', async () => {
    fake.readyMap = { email: true, sms: true };
    const mine = await addGuardian(STU_A, { name: '내보호자', email: 'mine@example.com' }).expect(201);
    const theirs = await addGuardian(STU_B, { name: '남보호자', email: 'theirs@example.com' }).expect(201);
    const send = (extra: Record<string, unknown>) => api('post', '/guardians/send')
      .send({ studentId: STU_A, guardianIds: [mine.body.id], channels: ['email'], body: '본문', requestKey: randomUUID(), ...extra });

    const wrong = await send({ guardianIds: [mine.body.id, theirs.body.id] }).expect(400);
    expect(wrong.body.code).toBe('GUARDIAN_NOT_OF_STUDENT');

    const otherNotice = await parentNotice(STU_B);
    const wrongNotice = await send({ pnotiId: otherNotice }).expect(400);
    expect(wrongNotice.body.code).toBe('PNOTI_NOT_OF_STUDENT');

    const smsOnly = await send({ channels: ['sms'] }).expect(400);
    expect(smsOnly.body.code).toBe('GUARDIAN_CHANNEL_MISMATCH');

    await api('delete', `/guardians/${mine.body.id}`).expect(200);
    const inactive = await send({}).expect(400);
    expect(inactive.body.code).toBe('GUARDIAN_INACTIVE');

    // 입력 모양 — 없는 채널 · 빈 보호자 · uuid 아님
    await send({ channels: ['kakao'] }).expect(400);
    await send({ guardianIds: [] }).expect(400);
    await send({ requestKey: 'not-a-uuid' }).expect(400);

    expect(fake.calls).toHaveLength(0);
    const [n] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM guardian_send WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
    expect(n.n).toBe(0);
  });

  it('⑨ 공급자가 받는 곳을 되돌려 실은 오류 — 원장에는 가려서 남고 PNOTI 는 찍지 않는다', async () => {
    fake.readyMap = { email: true, sms: false };
    fake.reply = (req) => ({ configured: true, ok: false, providerId: null, error: `550 mailbox unavailable: ${req.to}` });
    const g = await addGuardian(STU_A, { name: '김엄마', email: 'mom@example.com' }).expect(201);
    const pnotiId = await parentNotice(STU_A);
    const res = await api('post', '/guardians/send')
      .send({ studentId: STU_A, pnotiId, guardianIds: [g.body.id], channels: ['email'], body: '본문', requestKey: randomUUID() })
      .expect(200);
    expect(res.body.items[0]).toMatchObject({ status: 'failed', statusLabel: '보내지 못했습니다', error: '550 mailbox unavailable: mo***@example.com' });
    const [row] = await q<{ error: string }>(`SELECT error FROM guardian_send WHERE student_id = $1`, [STU_A]);
    expect(row.error).not.toContain('mom@example.com');
    const [p] = await q<{ sent_at: string | null }>(`SELECT sent_at FROM pnoti WHERE id = $1`, [pnotiId]);
    expect(p.sent_at).toBeNull();
  });

  it('⑩ 공급자를 부르는 곳이 상한(MAX_SEND_ATTEMPTS)을 넘으면 보내기 전에 거절한다 — 설정 없는 채널은 세지 않는다 (보안 검토 0925)', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const g = await addGuardian(STU_A, { name: `보호자${i}`, email: `g${i}@example.com`, phone: `0100000000${i}`, receiveSms: true }).expect(201);
      ids.push(g.body.id);
    }
    const body = () => ({ studentId: STU_A, guardianIds: ids, channels: ['email', 'sms'], body: '본문', requestKey: randomUUID() });

    // 5명 × 2채널 = 10곳 — 둘 다 설정됨 → 400 · 아무도 안 부르고 원장도 없다
    fake.readyMap = { email: true, sms: true };
    const tooMany = await api('post', '/guardians/send').send(body()).expect(400);
    expect(tooMany.body).toMatchObject({ code: 'GUARDIAN_SEND_TOO_MANY', message: expect.stringContaining('8곳') });
    expect(fake.calls).toHaveLength(0);
    const [n] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM guardian_send WHERE student_id = $1`, [STU_A]);
    expect(n.n).toBe(0);

    // 문자 설정이 없으면 부르는 곳은 메일 5곳뿐 — 통과하고 문자 5줄은 not_configured
    fake.readyMap = { email: true, sms: false };
    const ok = await api('post', '/guardians/send').send(body()).expect(200);
    expect(ok.body.counts).toEqual({ sent: 5, failed: 0, notConfigured: 5, skipped: 0 });
    expect(fake.calls.map((c) => c.to)).toEqual(ids.map((_, i) => `g${i + 1}@example.com`));
  });

  it('⑪ 가린 받는 곳은 원장 칸(80자) 안이다 — 긴 도메인 메일도 발송 뒤 INSERT 가 깨지지 않는다 (보안 검토 0925)', async () => {
    fake.readyMap = { email: true, sms: false };
    const email = `ab@${'d'.repeat(60)}.${'e'.repeat(40)}.example.com`;
    const g = await addGuardian(STU_A, { name: '긴도메인', email }).expect(201);
    const res = await api('post', '/guardians/send')
      .send({ studentId: STU_A, guardianIds: [g.body.id], channels: ['email'], body: '본문', requestKey: randomUUID() })
      .expect(200);
    expect(res.body.counts.sent).toBe(1);
    const [row] = await q<{ to_masked: string }>(`SELECT to_masked FROM guardian_send WHERE student_id = $1`, [STU_A]);
    expect(row.to_masked.length).toBeLessThanOrEqual(80);
    expect(row.to_masked.startsWith('a***@ddd')).toBe(true);
  });
});
