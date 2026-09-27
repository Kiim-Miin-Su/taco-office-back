/** @file-guide
 * 목적: §43-6 「강사 N명 한 번에」 — 오늘 온라인 회차의 강사 줌 안내 일괄 발송을 실제 HTTP/권한/DB 로 검증한다 (wave 6).
 * 책임/재사용: 기존 AppModule/ValidationPipe/AuthService 와 scratch DB fixture 를 재사용한다. 발송 판정·거절 문장은 서비스의
 *   sendGate·줌 안내 쓰기 한 벌에서 오고 테스트는 결과만 본다(제품 규칙을 복제하지 않는다).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 원문 §43 매번 머리 「26년 8월 21일 금요일 · 온라인 14건 · 오늘 … 강사 9명 한 번에」.
 *
 * 보는 것:
 *   ① 목록(`GET /guides`)의 `zoomBatch` — 「강사 N명」의 N 은 **보낼 수 있는 회차의 서로 다른 강사 수**이고 서버가 센다
 *   ② 일괄 발송은 보낼 수 있는 회차만 골라 **한 줄씩 제 트랜잭션**으로 보낸다 — 한 줄이 거절돼도 앞뒤 줄은 그대로 남는다
 *   ③ 못 보낸 줄은 서버의 이유(코드 + 문장)로 돌려준다 — 막힌 회차(계정·강사 없음)와 그 사이 남이 먼저 보낸 회차
 *   ④ 두 번째 호출은 보낼 것이 0 이다(pnoti_teacher_once) · 강사는 403 이고 아무것도 안 남는다
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { dataSourceOptions } from '../src/data-source';
import { todayKst } from '../src/lib/kst';
import { GuidesService } from '../src/modules/guides/guides.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

type Row = Record<string, unknown>;
type BatchRow = { serId: number; onDate: string; startMin: number; teacherId: number | null; teacherName: string | null;
  studentNames: string; code: string | null; reason: string | null };
type BatchResult = { sent: BatchRow[]; skipped: BatchRow[]; teacherCount: number; parentNotices: number };

d('§43-6 강사 N명 한 번에 — 줌 안내 일괄 발송 HTTP/DB (wave 6)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const ADMIN = 63010, A = 63011, B = 63012, C = 63013;
  const staff = [ADMIN, A, B, C];
  const S1 = 63010, S2 = 63011, S3 = 63012, S4 = 63013, S5 = 63014;
  const students = [S1, S2, S3, S4, S5];
  /* 회차 다섯 — 09:00 A · 10:00 A · 11:00 B 는 보낼 수 있고, 12:00 C 는 줌 계정이 없고, 13:00 은 강사가 없다 */
  const SER1 = -63001, SER2 = -63002, SER3 = -63003, SER4 = -63004, SER5 = -63005;
  const sers = [SER1, SER2, SER3, SER4, SER5];
  const ZACC = -63001;
  const KIND = 'w6-zoom-batch';
  const TODAY = todayKst();
  const tokens = new Map<number, string>();

  const sql = <T = Row>(statement: string, params: unknown[] = []): Promise<T[]> => ds.query(statement, params) as Promise<T[]>;
  const http = (method: 'get' | 'post', path: string, actor = ADMIN) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokens.get(actor)}`)
      .timeout({ response: 10000, deadline: 20000 });
  const mine = (rows: BatchRow[]) => rows.filter((row) => sers.includes(row.serId)).sort((a, b) => a.startMin - b.startMin);
  const teacherNotices = async (serId: number) =>
    (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='teacher'`, [serId, TODAY]))[0].n;
  const parentNotices = async (serId: number) =>
    (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='parent'`, [serId, TODAY]))[0].n;
  const notisTo = async (id: number) =>
    (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM noti WHERE to_id=$1`, [id]))[0].n;

  const cleanup = async () => {
    await sql(`DELETE FROM hist WHERE entity='pnoti' AND ref_id IN (SELECT id FROM pnoti WHERE ser_id=ANY($1::bigint[]))`, [sers]);
    await sql('DELETE FROM pnoti WHERE ser_id=ANY($1::bigint[])', [sers]);
    await sql('DELETE FROM noti WHERE to_id=ANY($1::bigint[]) OR from_id=ANY($1::bigint[])', [staff]);
    await sql('DELETE FROM ser_occ WHERE ser_id=ANY($1::bigint[])', [sers]);
    await sql('DELETE FROM ser_stu WHERE ser_id=ANY($1::bigint[])', [sers]);
    await sql('DELETE FROM ser WHERE id=ANY($1::bigint[])', [sers]);
  };

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DataSource).useValue(ds).compile();
    app = module.createNestApplication();
    app.useLogger(false); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const password = 'w6-zoom-batch-local-fixture-only';
    const hash = await bcrypt.hash(password, 4);
    for (const [id, role, name] of [[ADMIN, 'admin', 'W6 관리자'], [A, 'teacher', 'W6 강사 가'], [B, 'teacher', 'W6 강사 나'], [C, 'teacher', 'W6 강사 다']] as const) {
      const email = `w6-zoom-batch-${id}@t.invalid`;
      await sql('INSERT INTO staff(id,name,email,role,password_hash,active) VALUES ($1,$2,$3,$4,$5,true)', [id, name, email, role, hash]);
      const res = await request(app.getHttpServer()).post('/auth/login').send({ loginId: email, password }).expect(201);
      tokens.set(id, res.body.accessToken as string);
    }
    for (const [index, id] of students.entries()) await sql('INSERT INTO stu(id,name,grade) VALUES ($1,$2,$3)', [id, `W6 학생 ${index + 1}`, 'G9']);
    await sql(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'W6 온라인 수업','#123456',8,'lesson',false)`, [KIND]);
    await sql(`INSERT INTO zacc (id,label,login_email,login_secret,join_url,meeting_id,meeting_pw_enc,active)
      VALUES ($1,'W6 Study','w6-zoom-batch@t.invalid','\\x00','https://zoom.example/j/6300','630-001','\\x2a2a2a',true)`, [ZACC]);
  });

  beforeEach(async () => {
    await cleanup();
    const lessons: Array<[number, number | null, number | null, number, number]> = [
      [SER1, A, ZACC, S1, 9], [SER2, A, ZACC, S2, 10], [SER3, B, ZACC, S3, 11], [SER4, C, null, S4, 12], [SER5, null, ZACC, S5, 13],
    ];
    for (const [ser, teacher, zacc, student, hour] of lessons) {
      await sql(`INSERT INTO ser (id,kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
        VALUES ($1,$2,$3,'online',$4,$5,'ONCE',$6::date,$6::date,$7)`,
      [ser, KIND, teacher, hour * 60, hour * 60 + 60, TODAY, `W6 줌 일괄 ${hour}시`]);
      await sql('INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)', [ser, student]);
      await sql(`INSERT INTO ser_occ (ser_id,on_date,teacher_id,zacc_id,span)
        VALUES ($1,$2::date,$3,$4, tstzrange(($2::date + make_interval(hours => $5)) AT TIME ZONE 'Asia/Seoul',
                                              ($2::date + make_interval(hours => $5 + 1)) AT TIME ZONE 'Asia/Seoul','[)'))`,
      [ser, TODAY, teacher, zacc, hour]);
    }
  });

  afterEach(() => { jest.restoreAllMocks(); });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await cleanup();
      await sql('DELETE FROM zacc WHERE id=$1', [ZACC]);
      await sql('DELETE FROM kind WHERE key=$1', [KIND]);
      await sql('DELETE FROM stu WHERE id=ANY($1::bigint[])', [students]);
      await sql('DELETE FROM staff WHERE id=ANY($1::bigint[])', [staff]);
    }
    if (app) await app.close();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('① 목록의 zoomBatch — 「강사 N명」은 보낼 수 있는 회차의 서로 다른 강사 수다 (회차 3건 · 강사 2명)', async () => {
    const list = (await http('get', '/guides').expect(200)).body as { zoomBatch: Row; perLesson: Array<Row & { serId: number }> };
    // 이 스크래치 DB 의 오늘 온라인 회차는 이 스위트가 만든 다섯뿐이다(다른 스위트는 트랜잭션 안에서 되돌린다)
    expect(list.perLesson.filter((row) => sers.includes(row.serId))).toHaveLength(5);
    expect(list.zoomBatch).toEqual({ teacherCount: 2, lessonCount: 3, canSend: true, blockedReason: null });
  });

  it('②③ 일괄 발송은 한 줄씩 제 트랜잭션이다 — 그 사이 남이 먼저 보낸 줄만 거절되고 앞뒤 줄은 남는다 · 막힌 줄은 서버 이유로 돌려준다', async () => {
    /* 10:00 회차는 목록을 읽은 뒤·보내기 직전에 다른 사람이 먼저 보낸다 — 실제 쓰기(pnoti_teacher_once)가 거절해야 한다 */
    const service = GuidesService.prototype as unknown as { recordZoomNotice: (userId: number, dto: { serId: number; onDate: string }) => Promise<unknown> };
    const original = service.recordZoomNotice;
    jest.spyOn(service, 'recordZoomNotice').mockImplementation(async function (this: unknown, userId, dto) {
      if (dto.serId === SER2) {
        await sql(`INSERT INTO pnoti (ser_id,on_date,audience,staff_id,channel,body,sent_at)
          VALUES ($1,$2::date,'teacher',$3,'app','먼저 보낸 줌 안내',now())`, [SER2, TODAY, A]);
      }
      return original.call(this, userId, dto);
    });

    const res = (await http('post', '/guides/zoom-notice/batch').send({}).expect(201)).body as BatchResult;
    expect(mine(res.sent).map((row) => [row.serId, row.teacherId, row.code, row.reason])).toEqual([
      [SER1, A, null, null],
      [SER3, B, null, null],
    ]);
    expect(mine(res.sent)[0]).toMatchObject({ onDate: TODAY, startMin: 540, teacherName: 'W6 강사 가', studentNames: 'W6 학생 1' });
    expect(mine(res.skipped).map((row) => [row.serId, row.code, row.reason])).toEqual([
      [SER2, 'ZOOM_NOTICE_ALREADY', '이 회차의 줌 안내는 이미 보냈습니다'],
      [SER4, 'ZOOM_NOTICE_NO_ACCOUNT', '줌 계정이 아직 배정되지 않았습니다'],
      [SER5, 'ZOOM_NOTICE_NO_TEACHER', '강사가 아직 정해지지 않았습니다'],
    ]);
    expect(res.teacherCount).toBe(new Set(res.sent.map((row) => row.teacherId)).size);

    // DB — 보낸 두 줄은 강사 줄 1 · 학부모 줄 1 · 강사 알림 1, 거절된 10:00 은 먼저 보낸 한 줄 말고 아무것도 없다
    expect([await teacherNotices(SER1), await parentNotices(SER1)]).toEqual([1, 1]);
    expect([await teacherNotices(SER3), await parentNotices(SER3)]).toEqual([1, 1]);
    expect([await teacherNotices(SER2), await parentNotices(SER2)]).toEqual([1, 0]);
    expect([await teacherNotices(SER4), await teacherNotices(SER5)]).toEqual([0, 0]);
    expect([await notisTo(A), await notisTo(B), await notisTo(C)]).toEqual([1, 1, 0]);
    const [sentAt] = await sql<{ sent_at: Date | null }>(
      `SELECT sent_at FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='teacher'`, [SER3, TODAY]);
    expect(sentAt.sent_at).not.toBeNull();

    // 목록도 같은 사실을 말한다 — 보낼 것이 없으니 단추가 닫히고 이유가 선다
    const after = (await http('get', '/guides').expect(200)).body as { zoomBatch: Row };
    expect(after.zoomBatch).toMatchObject({ teacherCount: 0, lessonCount: 0, canSend: false, blockedReason: expect.any(String) });
  });

  it('④ 두 번째 호출은 보낼 것이 0 이다 — 보낸 줄은 「이미 보냈습니다」로 건너뛰고 새 줄을 만들지 않는다', async () => {
    await http('post', '/guides/zoom-notice/batch').send({}).expect(201);
    const before = await sql('SELECT id FROM pnoti WHERE ser_id=ANY($1::bigint[]) ORDER BY id', [sers]);
    const again = (await http('post', '/guides/zoom-notice/batch').send({}).expect(201)).body as BatchResult;
    expect(mine(again.sent)).toEqual([]);
    expect(mine(again.skipped).map((row) => [row.serId, row.code])).toEqual([
      [SER1, 'ZOOM_NOTICE_ALREADY'], [SER2, 'ZOOM_NOTICE_ALREADY'], [SER3, 'ZOOM_NOTICE_ALREADY'],
      [SER4, 'ZOOM_NOTICE_NO_ACCOUNT'], [SER5, 'ZOOM_NOTICE_NO_TEACHER'],
    ]);
    expect(mine(again.skipped)[0].reason).toBe('이미 보냈습니다');
    expect(await sql('SELECT id FROM pnoti WHERE ser_id=ANY($1::bigint[]) ORDER BY id', [sers])).toEqual(before);
    expect([await teacherNotices(SER1), await teacherNotices(SER2), await teacherNotices(SER3)]).toEqual([1, 1, 1]);
  });

  it('④ 강사는 403 이고 아무것도 남지 않는다 · 입력을 실어 보내면 400 이다', async () => {
    const res = await http('post', '/guides/zoom-notice/batch', A).send({});
    expect(res.status).toBe(403);
    const bad = await http('post', '/guides/zoom-notice/batch').send({ serIds: [SER1] });
    expect(bad.status).toBe(400);
    expect(await sql('SELECT id FROM pnoti WHERE ser_id=ANY($1::bigint[])', [sers])).toEqual([]);
    expect([await notisTo(A), await notisTo(B)]).toEqual([0, 0]);
  });
});
