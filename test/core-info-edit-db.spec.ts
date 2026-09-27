/** @file-guide
 * 목적: 문의·컨설팅 핵심정보 PATCH가 실제 ValidationPipe→서비스→DB→감사 원장을 관통하는지 검증한다.
 * 책임/재사용: 전용 ID로 만들고 스스로 치운다. 제품 규칙은 endpoint 응답과 DB 사실로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

d('문의·컨설팅 핵심정보 수정 — HTTP→DTO→DB→감사', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  const CEO = 9891;
  const OWNER = 9892;
  const STU1 = 99891;
  const STU2 = 99892;
  const PW = 'core-edit-12345';
  const leads: number[] = [];
  const cons: number[] = [];
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params) as Promise<T[]>;
  const api = (method: 'get' | 'post' | 'patch', path: string) => request(app.getHttpServer())[method](path)
    .set('Authorization', `Bearer ${token}`).timeout({ response: 10000, deadline: 20000 });

  async function cleanup() {
    if (!ds?.isInitialized) return;
    if (cons.length) {
      await q(`DELETE FROM cons_event WHERE cons_id=ANY($1)`, [cons]);
      await q(`DELETE FROM cons_item WHERE cons_id=ANY($1)`, [cons]);
      await q(`DELETE FROM cons_pick WHERE cons_id=ANY($1)`, [cons]);
      await q(`DELETE FROM cons_stu WHERE cons_id=ANY($1)`, [cons]);
      await q(`DELETE FROM cons WHERE id=ANY($1)`, [cons]);
    }
    if (leads.length) {
      await q(`DELETE FROM lead_touch WHERE lead_id=ANY($1)`, [leads]);
      await q(`DELETE FROM lead_stage_log WHERE lead_id=ANY($1)`, [leads]);
      await q(`DELETE FROM lead WHERE id=ANY($1)`, [leads]);
    }
    await q(`DELETE FROM log WHERE actor_id=ANY($1)`, [[CEO, OWNER]]);
    await q(`DELETE FROM stu WHERE id=ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM staff WHERE id=ANY($1)`, [[CEO, OWNER]]);
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await cleanup();
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id,name,email,role,password_hash,active) VALUES
       ($1,'핵심대표','core-ceo@t.kr','ceo',$3,true),($2,'핵심담당','core-owner@t.kr','manager',$3,true)`,
      [CEO, OWNER, hash],
    );
    await q(`INSERT INTO stu (id,name,grade,school) VALUES ($1,'핵심학생1','G10','전고'),($2,'핵심학생2','G11','후고')`, [STU1, STU2]);
    const login = await request(app.getHttpServer()).post('/auth/login').send({ loginId: 'core-ceo@t.kr', password: PW }).expect(201);
    token = login.body.accessToken as string;
  });
  afterAll(async () => { try { await cleanup(); } finally { await app?.close(); } });

  it('문의 카드 머리 다섯 칸을 수정하고 생략/비우기와 LOG 전후 값을 보존한다', async () => {
    const made = await api('post', '/ops/leads').send({ name: '수정 전', school: '전고', grade: 'G9', source: 'phone', ownerId: CEO }).expect(201);
    const id = Number(made.body.id); leads.push(id);
    const edited = await api('patch', `/ops/leads/${id}`).send({ name: '수정 후', school: null, grade: 'G11', source: 'referral', ownerId: OWNER }).expect(200);
    expect(edited.body).toMatchObject({ id, name: '수정 후', school: null, grade: 'G11', source: 'referral', ownerId: OWNER, ownerName: '핵심담당' });
    const [row] = await q(`SELECT name,school,grade,source,owner_id FROM lead WHERE id=$1`, [id]);
    expect(row).toMatchObject({ name: '수정 후', school: null, grade: 'G11', source: 'referral', owner_id: String(OWNER) });
    const [log] = await q(`SELECT before,after FROM log WHERE entity='LEAD' AND entity_id=$1 AND action='edit' ORDER BY id DESC LIMIT 1`, [id]);
    expect(log.before).toMatchObject({ name: '수정 전', school: '전고', ownerId: CEO });
    expect(log.after).toMatchObject({ name: '수정 후', school: null, ownerId: OWNER });
    await api('patch', `/ops/leads/${id}`).send({}).expect(409);
  });

  it('계약 1단계에서 핵심정보·학생 연결을 함께 바꾸고, 계약 작업 뒤에는 전부 거절한다', async () => {
    const made = await api('post', '/consulting').send({
      consType: 'admissions', studentIds: [STU1], requester: 'mother', ownerId: CEO,
      amount: 1000000, sessions: 4, startOn: '2026-10-01', endOn: '2026-12-31', share: 'all',
    }).expect(201);
    const id = Number(made.body.id); cons.push(id);
    const edited = await api('patch', `/consulting/${id}`).send({
      studentIds: [STU2], requester: 'father', ownerId: OWNER, amount: 1200000, sessions: 6,
      startOn: '2026-10-02', endOn: '2027-01-15',
    }).expect(200);
    expect(edited.body).toMatchObject({ id, studentIds: [STU2], requester: 'father', ownerId: OWNER, amount: 1200000, sessions: 6, startOn: '2026-10-02', endOn: '2027-01-15' });
    const students = await q(`SELECT student_id FROM cons_stu WHERE cons_id=$1`, [id]);
    expect(students.map((row) => Number(row.student_id))).toEqual([STU2]);
    const [log] = await q(`SELECT before,after FROM log WHERE entity='CONS' AND entity_id=$1 AND action='edit' ORDER BY id DESC LIMIT 1`, [id]);
    expect(log.before).toMatchObject({ studentIds: [STU1], requester: 'mother', amount: 1000000 });
    expect(log.after).toMatchObject({ studentIds: [STU2], requester: 'father', amount: 1200000 });

    // 실제 편집기는 바뀐 칸만 보낸다. 날짜를 생략해도 DB Date 객체 문자열을 재전송하지 않고 YYYY-MM-DD를 보존해야 한다.
    const partial = await api('patch', `/consulting/${id}`).send({ amount: 1250000 }).expect(200);
    expect(partial.body).toMatchObject({ amount: 1250000, startOn: '2026-10-02', endOn: '2027-01-15' });
    expect((await q(`SELECT amount,start_on::text,end_on::text FROM cons WHERE id=$1`, [id]))[0])
      .toMatchObject({ amount: 1250000, start_on: '2026-10-02', end_on: '2027-01-15' });

    await q(`UPDATE cons SET contract_step=2 WHERE id=$1`, [id]);
    const locked = await api('patch', `/consulting/${id}`).send({ amount: 1300000 }).expect(409);
    expect(locked.body.code).toBe('CONS_CORE_LOCKED');
    expect((await q(`SELECT amount FROM cons WHERE id=$1`, [id]))[0]?.amount).toBe(1250000);
  });
});
