/** @file-guide
 * 목적: schedule-w11-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 스케줄 결정 채택 — 실제 HTTP · DB (AppModule + supertest).
 *
 *   N-56  회차 방식 전환 — 한 트랜잭션(EXC · ZASSIGN · 투영) · 겹치면 409 로 통째로 · 함께 바뀐 것은 log 문장
 *         줌만 다른 회차의 예외가 다음 쓰기에서 사라지지 않는다 · 「향후」로 갈라도 줌 계정이 이어진다
 *   N-57  회차 메모 — 목록이 읽는다 · 「향후」로 보내도 가르지 않는다 · DB CHECK
 *   N-58  학생 겹침 알림 — 막지 않고 싣는다 · 그날 빠진 학생은 세지 않는다
 *   N-70  409 뒤 설명 한 줄 — 비어 있는 강의실 · 줌 계정 (각 최대 셋)
 *   N-73  감사 줄 — 규칙마다 한 줄 · 409 로 되돌아가면 0줄 · 되돌리기 · 불가 시간 삭제
 *   N-83  학생 성별 — 선택 칸 · 코드표 · 등록 확정
 *   N-100 §11 「안내 N」 — 보냈는데 확인 안 된 안내 수
 *   A′    회차의 실제 방식을 읽는 곳(줌 안내 목록 · 줌 안내 쓰기 · 강사 홈 · 서랍 「빠진 것」 · 현황판 · 회의)
 *         · 휴강 회차의 리포트 판정(스케줄 목록 = 리포트 목록 · na)
 *   A′2   회차의 장소 낱말(§43 「매번」 줄 · 회의 §63 · §66 · 안내 알림)과 안내 자동 채움의 「형태」 — 그 회차의 값
 *         (회차 투영 · 예외) · 회차가 없으면 규칙의 값
 *   A′3   안내 줄의 수업 이름표 강의실(§43 · §44 · §45) · 회의 시각 — 그 회차의 값 · 되돌리기(일정 · 결재)도 월 마감을 지난다
 *
 * 스위트 전용 번호대(staff 986~988 · stu 9986~9987 · room/zacc 9986~9988 · lead 8986)로 만들고 스스로 치운다.
 * 코드표(kind · room · zacc)도 스스로 만든다 — 빈 스크래치 DB(`*_test`)에서도, 시드가 든 DB 에서도 돈다.
 * 검증 실행은 `DATABASE_URL=$TEST_DATABASE_URL` 로 스크래치 DB 에 대고 돌렸다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

d('W11 스케줄 — 방식 전환 · 회차 메모 · 학생 겹침 · 빈 자원 · 감사 · 성별 · 안내 수', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'sched-w11-1234';
  const CEO = 986;
  const T1 = 987;
  const T2 = 988;
  const STU_A = 9986;
  const STU_B = 9987;
  const ROOM_A = 9986;
  const ROOM_B = 9987;
  const ROOM_C = 9988;
  const Z1 = 9986;
  const Z2 = 9987;
  const ZOFF = 9988;
  const LEAD = 8986;
  const KIND = 'w11_k';
  /** 리포트 대상 종류(rep=true) — 휴강 회차의 리포트 판정(A′)을 본다 */
  const KIND_R = 'w11_r';
  /** 시간표 회차에 이어 둔 회의 기록 (A′ — §63 · §66 이 읽는 방식) */
  const MEET = 8987;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const nextMon = (iso: string) => {
    let d0 = iso;
    while (new Date(`${d0}T00:00:00Z`).getUTCDay() !== 1) d0 = plus(d0, 1);
    return d0;
  };
  /** 오늘에서 1~2주 뒤 첫 월요일 — 호라이즌 안 · 마감 달 밖 */
  const MON = nextMon(plus(kst(), 7));

  const clearMine = async () => {
    // 회의 기록(A′)은 회차를 가리킨다 — 회차보다 먼저 치운다
    await q(`DELETE FROM mtattd WHERE mt_id = $1`, [MEET]);
    await q(`DELETE FROM mtrec WHERE id = $1`, [MEET]);
    const sers = (await q<{ id: string }>(
      `SELECT id FROM ser WHERE kind_key = ANY($1::text[]) OR teacher_id = ANY($2::bigint[])`, [[KIND, KIND_R], [T1, T2]],
    )).map((r) => Number(r.id));
    // 등록 확정이 남기는 것(안내 초안 · 교재 요청 · 등록 줄 · 학부모 안내)은 SER · 학생을 참조한다 — 먼저 치운다
    await q(`DELETE FROM guide WHERE ser_id = ANY($1) OR student_id IN (SELECT id FROM stu WHERE name LIKE 'W11등록%')`, [sers]);
    await q(`DELETE FROM pnoti WHERE ser_id = ANY($1) OR student_id IN (SELECT id FROM stu WHERE name LIKE 'W11등록%')`, [sers]);
    await q(`DELETE FROM issue WHERE student_id IN (SELECT id FROM stu WHERE name LIKE 'W11%')`);
    await q(`DELETE FROM enr WHERE student_id IN (SELECT id FROM stu WHERE name LIKE 'W11%')`);
    if (sers.length) {
      await q(`DELETE FROM todo WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM zassign WHERE ser_id = ANY($1) OR exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [sers]);
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [sers]);
      await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [sers]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [sers]);
    }
    await q(`DELETE FROM zlog WHERE actor_id = ANY($1::bigint[])`, [[CEO, T1, T2]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1::bigint[])`, [[CEO, T1, T2]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1::bigint[]) OR from_id = ANY($1::bigint[])`, [[CEO, T1, T2]]);
    // 줌 안내 쓰기(A′)가 남기는 이력 줄
    await q(`DELETE FROM hist WHERE by_id = ANY($1::bigint[])`, [[CEO, T1, T2]]);
    // 되돌리기 월 마감(A′3)이 남기는 변경 요청 · 마감 줄 — 마감 줄은 staff 를 참조한다
    await q(`DELETE FROM chreq WHERE by_id = ANY($1::bigint[])`, [[CEO, T1, T2]]);
    await q(`DELETE FROM month_close WHERE closed_by = ANY($1::bigint[]) OR reopened_by = ANY($1::bigint[])`, [[CEO, T1, T2]]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await clearMine();
    await q(`DELETE FROM guide WHERE teacher_id = ANY($1::bigint[])`, [[T1, T2]]);
    await q(`DELETE FROM unav WHERE staff_id = ANY($1::bigint[])`, [[T1, T2]]);
    for (const t of ['lead_stage_log', 'lead_touch', 'lead_diag', 'lead_plan', 'lead_appt']) {
      await q(`DELETE FROM ${t} WHERE lead_id = $1`, [LEAD]);
    }
    await q(`DELETE FROM lead WHERE id = $1`, [LEAD]);
    await q(`DELETE FROM stu WHERE id = ANY($1::bigint[]) OR name LIKE 'W11%'`, [[STU_A, STU_B]]);
    await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [[CEO, T1, T2]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'W11대표','w11-ceo@t.kr','ceo',$4,true),
         ($2,'W11강사일','w11-t1@t.kr','teacher',$4,true),
         ($3,'W11강사이','w11-t2@t.kr','teacher',$4,true)`,
      [CEO, T1, T2, hash],
    );
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'W11학생A','10'), ($2,'W11학생B','11')`, [STU_A, STU_B]);
    await q(
      `INSERT INTO kind (key, name, color, cap, grp, rep, sort) VALUES ($1,'W11수업','#123456',4,'lesson',false,99)
       ON CONFLICT (key) DO NOTHING`, [KIND],
    );
    await q(
      `INSERT INTO kind (key, name, color, cap, grp, rep, sort) VALUES ($1,'W11리포트','#654321',4,'lesson',true,98)
       ON CONFLICT (key) DO NOTHING`, [KIND_R],
    );
    await q(
      `INSERT INTO room (id, branch, name, active) VALUES ($1,'W11','위11-A',true),($2,'W11','위11-B',true),($3,'W11','위11-C',true)
       ON CONFLICT (id) DO NOTHING`, [ROOM_A, ROOM_B, ROOM_C],
    );
    await q(
      `INSERT INTO zacc (id, label, login_email, login_secret, join_url, active) VALUES
         ($1,'W11-Z1','w11z1@t.kr',decode('00','hex'),'https://zoom.example/w11-1',true),
         ($2,'W11-Z2','w11z2@t.kr',decode('00','hex'),'https://zoom.example/w11-2',true),
         ($3,'W11-OFF','w11z3@t.kr',decode('00','hex'),'https://zoom.example/w11-3',false)
       ON CONFLICT (id) DO NOTHING`, [Z1, Z2, ZOFF],
    );
    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ loginId, password: PW }).expect(201)).body.accessToken as string;
    token = await login('w11-ceo@t.kr');
    teacherToken = await login('w11-t1@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await clearMine();
        await q(`DELETE FROM guide WHERE teacher_id = ANY($1::bigint[])`, [[T1, T2]]);
        await q(`DELETE FROM unav WHERE staff_id = ANY($1::bigint[])`, [[T1, T2]]);
        for (const t of ['lead_stage_log', 'lead_touch', 'lead_diag', 'lead_plan', 'lead_appt']) {
          await q(`DELETE FROM ${t} WHERE lead_id = $1`, [LEAD]);
        }
        await q(`DELETE FROM lead WHERE id = $1`, [LEAD]);
        await q(`DELETE FROM stu WHERE id = ANY($1::bigint[]) OR name LIKE 'W11%'`, [[STU_A, STU_B]]);
        await q(`DELETE FROM zacc WHERE id = ANY($1::bigint[])`, [[Z1, Z2, ZOFF]]);
        await q(`DELETE FROM room WHERE id = ANY($1::bigint[])`, [[ROOM_A, ROOM_B, ROOM_C]]);
        await q(`DELETE FROM kind WHERE key = ANY($1::text[])`, [[KIND, KIND_R]]);
        await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [[CEO, T1, T2]]);
      }
    } finally {
      await app?.close();
    }
  });

  afterEach(clearMine);

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 8000, deadline: 15000 });

  /** 매주 월 10:00~11:00 — 기본 현장 · 강의실 A · 강사1 · 학생A */
  const makeSer = async (over: Record<string, unknown> = {}) => {
    const res = await api('post', '/schedule').send({
      kindKey: KIND, subKey: null, mode: 'offline', fromDate: MON, rrule: 'WEEKLY:MO',
      startMin: 600, endMin: 660, teacherId: T1, roomId: ROOM_A, title: 'W11 수업', studentIds: [STU_A], ...over,
    }).expect(201);
    return { id: res.body.serIds[0] as number, body: res.body };
  };
  const occAt = (serId: number, onDate: string) => q<{ room_id: string | null; zacc_id: string | null; canceled: boolean }>(
    `SELECT room_id, zacc_id, canceled FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [serId, onDate],
  ).then((r) => r[0]);
  const auditLines = (serId: number, action?: string) => q<{ action: string; before: unknown; after: unknown }>(
    `SELECT action, before, after FROM log WHERE entity = 'SER' AND entity_id = $1 ${action ? 'AND action = $2' : ''} ORDER BY id`,
    action ? [serId, action] : [serId],
  );

  /* ── N-56 ─────────────────────────────────────────────────────────────── */

  it.each([false, true])('N-56 생성도 온라인+강의실을 400으로 거절한다 — 점유=%s · DB 변경 없음', async (occupied) => {
    if (occupied) await makeSer();
    const snapshot = () => q(`SELECT
      (SELECT count(*) FROM ser) AS ser,
      (SELECT count(*) FROM ser_occ) AS occurrence,
      (SELECT count(*) FROM ser_stu) AS roster,
      (SELECT count(*) FROM log) AS audit,
      (SELECT count(*) FROM noti) AS notification`);
    const before = await snapshot();
    const res = await api('post', '/schedule').send({
      kindKey: KIND, mode: 'online', fromDate: MON, toDate: MON, rrule: 'ONCE',
      startMin: 600, endMin: 660, roomId: ROOM_A, studentIds: [STU_A],
    }).expect(400);
    expect(res.body.code).toBe('MODE_ROOM_ONLINE');
    expect(await snapshot()).toEqual(before);
  });

  it('N-56 강의실을 비운 온라인 생성은 대면 수업과 같은 시간에도 저장·조회·투영된다', async () => {
    const offline = await makeSer();
    const online = await makeSer({ mode: 'online', roomId: null, teacherId: T2, studentIds: [] });
    expect(await q(`SELECT mode::text AS mode, room_id FROM ser WHERE id = $1`, [online.id]))
      .toEqual([{ mode: 'online', room_id: null }]);
    expect(await occAt(online.id, MON)).toMatchObject({ room_id: null });
    expect(await occAt(offline.id, MON)).toMatchObject({ room_id: String(ROOM_A) });
    const list = await api('get', `/schedule/occurrences?from=${MON}&to=${MON}`).expect(200);
    expect((list.body.items as Array<Record<string, unknown>>).find((o) => o.serId === online.id))
      .toMatchObject({ mode: 'online', roomId: null });
  });

  it('N-56 이번만 온라인 → 강의실 비움 · EXC 대상 줌 배정 · 투영 · 목록 · 문장 — 다시 현장으로 돌리면 전부 되돌아간다', async () => {
    const { id } = await makeSer();
    const on = await api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: MON, mode: 'online', zaccId: Z1 }).expect(200);
    expect(on.body.log).toEqual([`${MON} 회차만 바꿨습니다`, '온라인 수업으로 바꿨습니다', '강의실을 비웠습니다', '줌 계정을 배정했습니다']);
    expect(await q(`SELECT mode, room_set, room_id FROM exc WHERE ser_id = $1 AND on_date = $2::date`, [id, MON]))
      .toEqual([{ mode: 'online', room_set: true, room_id: null }]);
    expect(await q(
      `SELECT z.zacc_id, z.fixed, z.ser_id FROM zassign z JOIN exc e ON e.id = z.exc_id WHERE e.ser_id = $1`, [id],
    )).toEqual([{ zacc_id: String(Z1), fixed: false, ser_id: null }]);
    expect(await occAt(id, MON)).toMatchObject({ room_id: null, zacc_id: String(Z1) });
    expect(await occAt(id, plus(MON, 7))).toMatchObject({ room_id: String(ROOM_A), zacc_id: null });
    const list = await api('get', `/schedule/occurrences?from=${MON}&to=${plus(MON, 7)}`).expect(200);
    const mine = (list.body.items as Array<Record<string, unknown>>).filter((o) => o.serId === id);
    expect(mine.map((o) => [o.date, o.mode, o.roomId, o.zaccId])).toEqual([
      [MON, 'online', null, Z1],
      [plus(MON, 7), 'offline', ROOM_A, null],
    ]);
    // 규칙은 그대로다
    expect(await q(`SELECT mode::text AS mode, room_id FROM ser WHERE id = $1`, [id])).toEqual([{ mode: 'offline', room_id: String(ROOM_A) }]);

    const off = await api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: MON, mode: 'offline' }).expect(200);
    expect(off.body.log).toEqual([`${MON} 회차만 바꿨습니다`, '현장 수업으로 바꿨습니다', '줌 계정을 풀었습니다']);
    expect(await q(`SELECT id FROM exc WHERE ser_id = $1`, [id])).toEqual([]);
    expect(await q(`SELECT z.id FROM zassign z JOIN exc e ON e.id = z.exc_id WHERE e.ser_id = $1`, [id])).toEqual([]);
    expect(await occAt(id, MON)).toMatchObject({ room_id: String(ROOM_A), zacc_id: null });
  });

  it('N-56 겹치면 409 로 통째로 되돌아간다 — 예외 · 배정 · 감사 줄 아무것도 남지 않는다', async () => {
    const a = await makeSer();
    const b = await makeSer({ mode: 'online', roomId: null, teacherId: T2, studentIds: [] });
    await api('post', '/zoom/assign').send({ serId: b.id, zaccId: Z2 }).expect(201);
    const auditBefore = (await auditLines(a.id)).length;
    const res = await api('patch', `/schedule/${a.id}`).send({ scope: 'this', onDate: MON, mode: 'online', zaccId: Z2 }).expect(409);
    expect(res.body.code).toBe('RESOURCE_CONFLICT');
    expect(await q(`SELECT id FROM exc WHERE ser_id = $1`, [a.id])).toEqual([]);
    expect(await occAt(a.id, MON)).toMatchObject({ room_id: String(ROOM_A), zacc_id: null });
    expect((await auditLines(a.id)).length).toBe(auditBefore);
  });

  it('N-56 입력 방어 — 줌만 · 온라인+강의실 · 꺼 둔 계정 · 없는 계정은 저장하지 않는다', async () => {
    const { id } = await makeSer();
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ zaccId: Z1 }, 400, 'MODE_ZOOM_NEEDS_ONLINE'],
      [{ mode: 'offline', zaccId: Z1 }, 400, 'MODE_ZOOM_NEEDS_ONLINE'],
      [{ mode: 'online', roomId: ROOM_B }, 400, 'MODE_ROOM_ONLINE'],
      [{ mode: 'online', zaccId: ZOFF }, 409, 'ZACC_INACTIVE'],
      [{ mode: 'online', zaccId: 987654321 }, 404, 'ZACC_NOT_FOUND'],
    ];
    for (const [body, status, code] of cases) {
      const res = await api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: MON, ...body });
      expect([res.status, res.body.code]).toEqual([status, code]);
    }
    expect((await api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: MON, mode: null })).status).toBe(400);
    expect(await q(`SELECT id FROM exc WHERE ser_id = $1`, [id])).toEqual([]);
  });

  it('N-56 줌만 다른 회차의 예외가 다음 쓰기에서 사라지지 않는다 · 예외가 온라인으로 바꾼 회차에도 계정 화면이 배정한다', async () => {
    const online = await makeSer({ mode: 'online', roomId: null, teacherId: T2, studentIds: [] });
    await api('post', '/zoom/assign').send({ serId: online.id, zaccId: Z2 }).expect(201);
    await api('post', '/zoom/assign').send({ serId: online.id, onDate: MON, zaccId: Z1 }).expect(201);
    // 다른 회차를 고친다 — 전에는 정리 규칙이 줌만 가진 예외를 지워 배정이 CASCADE 로 사라졌다
    await api('patch', `/schedule/${online.id}`).send({ scope: 'this', onDate: plus(MON, 7), startMin: 630, endMin: 690 }).expect(200);
    expect(await occAt(online.id, MON)).toMatchObject({ zacc_id: String(Z1) });
    expect(await occAt(online.id, plus(MON, 7))).toMatchObject({ zacc_id: String(Z2) });

    // 현장 규칙의 한 회차를 온라인으로 바꾼 뒤 계정 화면에서 붙인다 — 규칙이 아니라 그 회차의 방식을 본다
    const offline = await makeSer({ startMin: 780, endMin: 840 });
    await api('patch', `/schedule/${offline.id}`).send({ scope: 'this', onDate: MON, mode: 'online' }).expect(200);
    await api('post', '/zoom/assign').send({ serId: offline.id, onDate: MON, zaccId: Z1 }).expect(201);
    expect(await occAt(offline.id, MON)).toMatchObject({ zacc_id: String(Z1), room_id: null });
    const notOnline = await api('post', '/zoom/assign').send({ serId: offline.id, onDate: plus(MON, 7), zaccId: Z1 }).expect(409);
    expect(notOnline.body.code).toBe('ZOOM_ASSIGN_NOT_ONLINE');
  });

  it('N-56 향후로 가르면 새 규칙이 줌 계정을 이어받는다 · 모두로 온라인 전환은 규칙에 계정을 붙인다', async () => {
    const online = await makeSer({ mode: 'online', roomId: null, teacherId: T2, studentIds: [] });
    await api('post', '/zoom/assign').send({ serId: online.id, zaccId: Z2 }).expect(201);
    const split = await api('patch', `/schedule/${online.id}`).send({ scope: 'future', onDate: plus(MON, 7), startMin: 630, endMin: 690 }).expect(200);
    const copy = (split.body.serIds as number[]).find((x) => x !== online.id)!;
    expect(split.body.log[0]).toBe(`${plus(MON, 7)} 부터 규칙을 나눴습니다`);
    expect(await q(`SELECT zacc_id, fixed FROM zassign WHERE ser_id = $1`, [copy])).toEqual([{ zacc_id: String(Z2), fixed: true }]);
    expect(await occAt(copy, plus(MON, 14))).toMatchObject({ zacc_id: String(Z2) });
    // N-73 — 규칙 둘이 바뀌었으니 두 줄 (원래 규칙은 끝날 · 새 규칙은 만들기 모양)
    expect((await auditLines(online.id, 'patch')).map((l) => l.after)).toEqual([expect.objectContaining({ toDate: plus(MON, 6) })]);
    const [copyLine] = await auditLines(copy, 'patch');
    expect(copyLine.before).toBeNull();
    expect(copyLine.after).toMatchObject({ fromDate: plus(MON, 7), startMin: 630, mode: 'online' });

    const offline = await makeSer({ startMin: 780, endMin: 840 });
    const all = await api('patch', `/schedule/${offline.id}`).send({ scope: 'all', onDate: MON, mode: 'online', zaccId: Z1 }).expect(200);
    expect(all.body.log).toEqual(expect.arrayContaining(['온라인 수업으로 바꿨습니다', '강의실을 비웠습니다', '줌 계정을 배정했습니다']));
    expect(await q(`SELECT mode::text AS mode, room_id FROM ser WHERE id = $1`, [offline.id])).toEqual([{ mode: 'online', room_id: null }]);
    expect(await q(`SELECT zacc_id, fixed FROM zassign WHERE ser_id = $1`, [offline.id])).toEqual([{ zacc_id: String(Z1), fixed: true }]);
    expect(await occAt(offline.id, plus(MON, 14))).toMatchObject({ room_id: null, zacc_id: String(Z1) });
  });

  /* ── N-57 ─────────────────────────────────────────────────────────────── */

  it('N-57 회차 메모 — 「향후」로 보내도 가르지 않고 그 회차에만 · 목록이 읽는다 · 지우기 · 200자 · DB CHECK', async () => {
    const { id } = await makeSer();
    const res = await api('patch', `/schedule/${id}`).send({ scope: 'future', onDate: plus(MON, 7), memo: '  모의고사 오답 리뷰 우선  ' }).expect(200);
    expect(res.body).toMatchObject({ effScope: 'this', log: ['회차 메모를 적었습니다'] });
    expect(res.body.serIds).toEqual([id]);
    expect(await q(`SELECT count(*)::int AS n FROM ser WHERE id = $1 OR (kind_key = $2 AND from_date > $3::date)`, [id, KIND, MON])).toEqual([{ n: 1 }]);
    const list = await api('get', `/schedule/occurrences?from=${MON}&to=${plus(MON, 7)}`).expect(200);
    const memos = (list.body.items as Array<Record<string, unknown>>).filter((o) => o.serId === id).map((o) => o.memo);
    expect(memos).toEqual([null, '모의고사 오답 리뷰 우선']);

    expect((await api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: MON, memo: 'x'.repeat(201) })).status).toBe(400);
    await api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: plus(MON, 7), memo: '' }).expect(200);
    expect(await q(`SELECT id FROM exc WHERE ser_id = $1`, [id])).toEqual([]);

    // 표가 마지막으로 막는다 — 공백만인 메모 · 없는 방식 낱말
    await expect(q(`INSERT INTO exc (ser_id, on_date, memo) VALUES ($1, $2::date, '   ')`, [id, MON])).rejects.toMatchObject({ code: '23514' });
    await expect(q(`INSERT INTO exc (ser_id, on_date, mode) VALUES ($1, $2::date, 'hybrid')`, [id, MON])).rejects.toMatchObject({ code: '23514' });
  });

  /* ── N-58 ─────────────────────────────────────────────────────────────── */

  it('N-58 학생 겹침 — 막지 않고 싣는다 · 명단 넣기는 그 학생만 · 그날만 빠진 학생은 세지 않는다', async () => {
    const a = await makeSer();
    const c = await makeSer({ teacherId: T2, roomId: ROOM_B, title: 'W11 겹침' });
    const overlaps = c.body.studentOverlaps as Array<Record<string, unknown>>;
    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps.length).toBeLessThanOrEqual(10);
    expect(overlaps[0]).toEqual({
      serId: c.id, date: MON, studentId: STU_A, studentName: 'W11학생A',
      otherSerId: a.id, otherTitle: 'W11 수업', otherStartMin: 600, otherEndMin: 660,
    });

    // 명단 넣기 — 넣은 학생만 본다 (B 는 다른 수업이 없다)
    const addB = await api('patch', `/schedule/${c.id}/roster`).send({ op: 'add', onDate: MON, studentId: STU_B }).expect(200);
    expect(addB.body.studentOverlaps).toEqual([]);
    // 빼기는 싣지 않는다
    const drop = await api('patch', `/schedule/${c.id}/roster`).send({ op: 'dropOnce', onDate: MON, studentId: STU_A }).expect(200);
    expect(drop.body.studentOverlaps).toEqual([]);
    // 그날만 빠진 학생은 그날 겹침이 아니다
    const moved = await api('patch', `/schedule/${c.id}`).send({ scope: 'this', onDate: plus(MON, 7), teacherId: T2 }).expect(200);
    const dates = (moved.body.studentOverlaps as Array<{ date: string; studentId: number }>).map((o) => o.date);
    expect(dates).not.toContain(MON);
    expect(dates[0]).toBe(plus(MON, 7));
    // 휴강 · 삭제는 겹침을 만들지 않으므로 싣지 않는다
    const cancel = await api('delete', `/schedule/${c.id}`).send({ scope: 'this', onDate: plus(MON, 14) }).expect(200);
    expect(cancel.body.studentOverlaps).toEqual([]);
  });

  /* ── N-70 ─────────────────────────────────────────────────────────────── */

  it('N-70 409 뒤 설명 — 그 시각 비어 있는 강의실 · 줌 계정 (각 최대 셋) · 물은 종류만 · 꺼 둔 계정은 빼고', async () => {
    const a = await makeSer();
    const b = await makeSer({ mode: 'online', roomId: null, teacherId: T2, studentIds: [] });
    await api('post', '/zoom/assign').send({ serId: b.id, zaccId: Z1 }).expect(201);
    const probe = `date=${MON}&startMin=600&endMin=660`;
    const room = await api('get', `/schedule/conflicts?${probe}&roomId=${ROOM_A}`).expect(200);
    expect(room.body.conflicts.map((r: { serId: number; with: string }) => [r.serId, r.with])).toEqual([[a.id, 'room']]);
    const roomLine = String(room.body.freeLine);
    expect(roomLine.startsWith('그 시각 비어 있는 강의실 — ')).toBe(true);
    expect(roomLine).not.toContain('위11-A');
    expect(roomLine.replace('그 시각 비어 있는 강의실 — ', '').split(' · ').length).toBeLessThanOrEqual(3);

    const zoom = await api('get', `/schedule/conflicts?${probe}&zaccId=${Z1}`).expect(200);
    const zoomLine = String(zoom.body.freeLine);
    expect(zoomLine.startsWith('그 시각 비어 있는 줌 계정 — ')).toBe(true);
    expect(zoomLine).not.toContain('W11-Z1');
    expect(zoomLine).not.toContain('W11-OFF');

    // 자기 자신은 자리를 비워 줄 것이므로 빈 것으로 센다 · 강사만 물으면 설명 줄이 없다.
    // 줄은 번호 차례로 셋까지다 — 시드가 든 DB 에서는 앞 번호(시드) 강의실이 셋을 먼저 채울 수 있다.
    // 그래서 「셋 안에 위11-A(9986) 자리가 있는가」를 제외 없이 물은 줄로 먼저 본다: 더 뒤 번호인 위11-C(9988)가
    // 그 줄에 들어 있으면 위11-A 도 들어가야 하고, 아니면 앞 번호 셋이 그대로라 두 줄이 같아야 한다(빈 스크래치 DB 는 앞 갈래).
    const listOf = (line: unknown) => String(line).replace('그 시각 비어 있는 강의실 — ', '').split(' · ');
    const plain = await api('get', `/schedule/conflicts?${probe}&roomId=${ROOM_B}`).expect(200);
    const self = await api('get', `/schedule/conflicts?${probe}&roomId=${ROOM_B}&exceptSerId=${a.id}`).expect(200);
    expect(listOf(plain.body.freeLine)).not.toContain('위11-A');
    if (listOf(plain.body.freeLine).includes('위11-C')) expect(listOf(self.body.freeLine)).toContain('위11-A');
    else expect(self.body.freeLine).toBe(plain.body.freeLine);
    const teacherOnly = await api('get', `/schedule/conflicts?${probe}&teacherId=${T1}`).expect(200);
    expect(teacherOnly.body.freeLine).toBeNull();
  });

  /* ── N-73 ─────────────────────────────────────────────────────────────── */

  it('N-73 감사 줄 — 만들기 · 고치기 · 되돌리기가 규칙마다 한 줄이고 같은 트랜잭션이다', async () => {
    const { id, body } = await makeSer();
    const created = await auditLines(id, 'create');
    expect(created).toHaveLength(1);
    expect(created[0].before).toBeNull();
    expect(created[0].after).toMatchObject({ kind: KIND, mode: 'offline', roomId: ROOM_A, roster: [{ studentId: STU_A }] });
    expect(JSON.stringify(created[0].after)).not.toContain('zaccId');
    expect(body.undoToken).toEqual(expect.any(String));

    const patched = await api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: MON, startMin: 630, endMin: 690 }).expect(200);
    const [line] = await auditLines(id, 'patch');
    expect(line.before).toEqual({ exc: { [MON]: null } });
    expect(line.after).toMatchObject({ exc: { [MON]: { startMin: 630, endMin: 690 } } });

    await api('post', '/schedule/undo').send({ token: patched.body.undoToken }).expect(201);
    const [undone] = await auditLines(id, 'undo');
    expect(undone.before).toMatchObject({ exc: { [MON]: { startMin: 630 } } });
    expect(undone.after).toEqual({ exc: { [MON]: null } });
    expect(await q(`SELECT actor_id FROM log WHERE entity = 'SER' AND entity_id = $1 GROUP BY actor_id`, [id])).toEqual([{ actor_id: String(CEO) }]);
  });

  it('N-73 불가 시간 삭제 — 지운 줄을 감사 원장에 통째로 · 잠긴 줄은 줄도 안 남긴다', async () => {
    const open = plus(kst(), 30);
    const locked = plus(kst(), 1);
    const [row] = await q<{ id: string }>(
      `INSERT INTO unav (staff_id, dow, on_date, start_min, end_min, reason) VALUES ($1, EXTRACT(DOW FROM $2::date), $2::date, 600, 720, '학회')
       RETURNING id`, [T1, open],
    );
    const [lockedRow] = await q<{ id: string }>(
      `INSERT INTO unav (staff_id, dow, on_date, start_min, end_min, reason) VALUES ($1, EXTRACT(DOW FROM $2::date), $2::date, 600, 720, '마감')
       RETURNING id`, [T1, locked],
    );
    await api('delete', `/teacher/unavailable/${row.id}`, teacherToken).expect(200);
    expect(await q(`SELECT actor_id, entity, entity_id, action, before, after FROM log WHERE entity = 'UNAV' AND entity_id = $1`, [row.id]))
      .toEqual([{
        actor_id: String(T1), entity: 'UNAV', entity_id: String(row.id), action: 'delete',
        before: { staffId: T1, onDate: open, startMin: 600, endMin: 720, reason: '학회' }, after: null,
      }]);
    expect((await api('delete', `/teacher/unavailable/${lockedRow.id}`, teacherToken)).status).toBe(409);
    expect(await q(`SELECT id FROM log WHERE entity = 'UNAV' AND entity_id = $1`, [lockedRow.id])).toEqual([]);
    expect(await q(`SELECT id FROM unav WHERE id = $1`, [lockedRow.id])).toHaveLength(1);
  });

  /* ── N-100 · N-83 ─────────────────────────────────────────────────────── */

  it('N-100 §11 「안내 N」 — 그 강사에게 보냈는데 확인 안 된 것만 · 강사는 403 · 없는 사람 404', async () => {
    await q(
      `INSERT INTO guide (student_id, teacher_id, reason, state) VALUES
         ($1,$2,'new','sent'),($1,$2,'new','sent'),($1,$2,'new','read'),($1,$2,'new','draft'),($1,$3,'new','sent')`,
      [STU_A, T1, T2],
    );
    expect((await api('get', `/schedule/teachers/${T1}/guides`).expect(200)).body).toEqual({ teacherId: T1, unconfirmed: 2 });
    expect((await api('get', `/schedule/teachers/${T2}/guides`).expect(200)).body).toEqual({ teacherId: T2, unconfirmed: 1 });
    await api('get', `/schedule/teachers/${T1}/guides`, teacherToken).expect(403);
    expect((await api('get', '/schedule/teachers/987654321/guides').expect(404)).body.code).toBe('STAFF_NOT_FOUND');
    expect((await api('get', '/schedule/teachers/0/guides')).status).toBe(400);
  });

  it('N-83 학생 성별 — 코드표 · 관리 화면 명단만 · 등록 확정이 선택 칸을 저장한다 · 두 낱말 밖은 400 · DB CHECK', async () => {
    const meta = await api('get', '/meta').expect(200);
    expect(meta.body.genders).toEqual([{ key: 'female', label: '여' }, { key: 'male', label: '남' }]);
    expect((meta.body.students as Array<{ id: number; gender: string | null }>).find((s) => s.id === STU_A)).toMatchObject({ gender: null });
    // 강사에게는 명단 자체가 없다 — 성별도 가지 않는다
    expect((await api('get', '/meta', teacherToken).expect(200)).body.students).toEqual([]);

    await q(`INSERT INTO lead (id, name, school, stage, owner_id) VALUES ($1, 'W11등록', 'W11고', 'first', $2)`, [LEAD, CEO]);
    const body = (gender: unknown) => ({
      startedOn: plus(MON, 7), issueInvoice: false, student: { name: 'W11등록', grade: '9', gender },
      lines: [{ kindKey: KIND, subKey: null, mode: 'offline', rrule: 'WEEKLY:TU', startMin: 900, endMin: 960, teacherId: T2, roomId: ROOM_C, libId: null }],
    });
    expect((await api('post', `/ops/leads/${LEAD}/enroll`).send(body('other'))).status).toBe(400);
    const res = await api('post', `/ops/leads/${LEAD}/enroll`).send(body('female')).expect(201);
    expect(await q(`SELECT gender FROM stu WHERE id = $1`, [res.body.studentId])).toEqual([{ gender: 'female' }]);
    await expect(q(`UPDATE stu SET gender = 'x' WHERE id = $1`, [res.body.studentId])).rejects.toMatchObject({ code: '23514' });
  });

  /* ── A′ 후속 — 회차의 실제 방식을 읽는 곳 (N-56 뒤 · lib/sql.effectiveModeOf 한 조각) ───────── */

  /** 오늘(KST) — §43 회차 안내와 강사 홈 「오늘」은 오늘 그려지는 회차만 본다 */
  const TODAY = kst();

  /**
   * 오늘 새벽 단발 둘 — ① 현장 규칙인데 그 회차만 온라인(줌 Z1) ② 온라인 규칙(규칙 줌 Z2)인데 그 회차만 현장(강의실 B).
   * 규칙의 방식으로 읽으면 둘이 뒤바뀐다.
   */
  const switchedToday = async () => {
    const toOnline = await makeSer({ fromDate: TODAY, rrule: 'ONCE', startMin: 300, endMin: 330 });
    await api('patch', `/schedule/${toOnline.id}`).send({ scope: 'this', onDate: TODAY, mode: 'online', zaccId: Z1 }).expect(200);
    const toOffline = await makeSer({
      fromDate: TODAY, rrule: 'ONCE', mode: 'online', roomId: null, startMin: 340, endMin: 370, studentIds: [STU_B],
    });
    await api('post', '/zoom/assign').send({ serId: toOffline.id, zaccId: Z2 }).expect(201);
    await api('patch', `/schedule/${toOffline.id}`).send({ scope: 'this', onDate: TODAY, mode: 'offline', roomId: ROOM_B }).expect(200);
    return { toOnline: toOnline.id, toOffline: toOffline.id };
  };

  it('A′ 회차 안내 · 줌 안내 · 강사 홈 — 그 회차만 온라인은 온라인으로, 그 회차만 현장은 현장으로 읽는다', async () => {
    const { toOnline, toOffline } = await switchedToday();

    // §43 「회차마다 나가는 안내」 — 오늘 온라인 회차만 선다
    const guides = await api('get', '/guides').expect(200);
    const lessonIds = (guides.body.perLesson as Array<{ serId: number }>).map((l) => l.serId);
    expect(lessonIds).toContain(toOnline);
    expect(lessonIds).not.toContain(toOffline);
    // 줌 안내 쓰기의 「온라인인가」도 같은 조각이다
    await api('post', '/guides/zoom-notice').send({ serId: toOnline, onDate: TODAY }).expect(201);
    const refused = await api('post', '/guides/zoom-notice').send({ serId: toOffline, onDate: TODAY }).expect(409);
    expect(refused.body.code).toBe('ZOOM_NOTICE_NOT_ONLINE');

    // 강사 홈 「오늘」 — 대면 · 비대면 글자가 그 회차의 방식이다
    const home = await api('get', '/teacher/home', teacherToken).expect(200);
    const modeOf = (serId: number) => (home.body.today as Array<{ serId: number; mode: string }>).find((l) => l.serId === serId)?.mode;
    expect(modeOf(toOnline)).toBe('online');
    expect(modeOf(toOffline)).toBe('offline');
  });

  it('A′ 서랍 「빠진 것」 · 현황판 — 줌 없는 온라인 회차와 줌 마크를 그 회차의 방식으로 가른다', async () => {
    const toOnline = await makeSer();
    await api('patch', `/schedule/${toOnline.id}`).send({ scope: 'this', onDate: MON, mode: 'online', zaccId: null }).expect(200);
    const toOffline = await makeSer({ mode: 'online', roomId: null, teacherId: T2, studentIds: [], startMin: 700, endMin: 760 });
    await api('post', '/zoom/assign').send({ serId: toOffline.id, zaccId: Z2 }).expect(201);
    await api('patch', `/schedule/${toOffline.id}`).send({ scope: 'this', onDate: MON, mode: 'offline', roomId: ROOM_B }).expect(200);
    const occId = async (serId: number) => Number((await q<{ id: string }>(
      `SELECT id FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [serId, MON],
    ))[0].id);

    // §14 「빠진 것」 — 줌 계정이 없는 온라인 회차(앞으로 30일)
    const drawer = await api('get', '/drawer').expect(200);
    const missing = (drawer.body.approvals.inbox as Array<{ kind: string; id: number }>)
      .filter((row) => row.kind === 'missing').map((row) => row.id);
    expect(missing).toContain(await occId(toOnline.id));
    expect(missing).not.toContain(await occId(toOffline.id));

    // §34 현황판 — 줌 마크는 온라인 회차에만 선다
    type Row = { serId: number; mode: string; marks: Array<{ key: string; na: boolean; done: boolean }> };
    const board = await api('get', `/board?from=${MON}&to=${MON}`).expect(200);
    const rowOf = (serId: number) => (board.body.rows as Row[]).find((r) => r.serId === serId)!;
    expect(rowOf(toOnline.id).mode).toBe('online');
    expect(rowOf(toOnline.id).marks.find((m) => m.key === 'zoom')).toMatchObject({ na: false, done: false });
    expect(rowOf(toOffline.id).mode).toBe('offline');
    expect(rowOf(toOffline.id).marks.find((m) => m.key === 'zoom')).toMatchObject({ na: true });
  });

  it('A′ 회의 — 이어진 회차를 그 회차만 온라인으로 바꾸면 §63 줄 · §66 머리 · 안내 알림이 온라인으로 적는다', async () => {
    const lesson = await makeSer({ fromDate: MON, rrule: 'ONCE', roomId: ROOM_C, startMin: 780, endMin: 840, studentIds: [] });
    await q(`INSERT INTO mtrec (id, mt_type, title, on_date, ser_id) VALUES ($1, 'general', 'W11 회의', $2::date, $3)`, [MEET, MON, lesson.id]);
    await q(`INSERT INTO mtattd (mt_id, staff_id) VALUES ($1, $2)`, [MEET, T1]);
    const place = async () => (await api('get', `/ops/meetings/${MEET}`).expect(200)).body.placeLabel as string | null;
    expect(await place()).toBe('위11-C');

    await api('patch', `/schedule/${lesson.id}`).send({ scope: 'this', onDate: MON, mode: 'online', zaccId: null }).expect(200);
    expect(await place()).toBe('온라인');
    const ops = await api('get', `/ops?from=${MON}&to=${MON}`).expect(200);
    expect((ops.body.meetings as Array<{ id: number; placeLabel: string | null }>).find((m) => m.id === MEET)?.placeLabel).toBe('온라인');
    await api('post', `/ops/meetings/${MEET}/notice`).expect(201);
    const [noti] = await q<{ body: string }>(`SELECT body FROM noti WHERE to_id = $1 AND link LIKE $2`, [T1, `%meeting=${MEET}`]);
    expect(noti.body).toContain('온라인');
    expect(noti.body).not.toContain('위11-C');
  });

  /* ── A′ 후속 — 휴강 회차의 리포트 판정 (스케줄 목록 = 리포트 목록 · 한 판정) ─────────────── */

  it('A′ 휴강 회차는 리포트 대상이 아니다 — 스케줄 목록도 리포트 목록처럼 na · 이미 올린 리포트가 있어도 na', async () => {
    const past = plus(TODAY, -3);
    const plain = await makeSer({ kindKey: KIND_R, fromDate: past, rrule: 'ONCE' });
    const written = await makeSer({ kindKey: KIND_R, fromDate: past, rrule: 'ONCE', roomId: ROOM_B, startMin: 700, endMin: 760 });
    // 강사가 쓰고 낸(승인 대기) 뒤에 휴강한 회차
    await q(
      `UPDATE rep SET state = 'wait', body = '{"content":"c","progress":"p","homework":"h"}'::jsonb,
              written_at = now(), submitted_at = now()
        WHERE ser_id = $1 AND on_date = $2::date`,
      [written.id, past],
    );
    type Item = { serId: number; canceled: boolean; repState: string; written: boolean };
    const items = async () => (await api('get', `/schedule/occurrences?from=${past}&to=${past}`).expect(200)).body.items as Item[];
    const of = (list: Item[], serId: number) => list.find((o) => o.serId === serId);

    const before = await items();
    expect(of(before, plain.id)).toMatchObject({ canceled: false, repState: 'none', written: false });
    expect(of(before, written.id)).toMatchObject({ canceled: false, repState: 'wait', written: true });

    for (const s of [plain, written]) {
      await api('delete', `/schedule/${s.id}`).send({ scope: 'this', onDate: past, cancelKind: 'academy' }).expect(200);
    }
    const after = await items();
    expect(of(after, plain.id)).toMatchObject({ canceled: true, repState: 'na', written: false });
    expect(of(after, written.id)).toMatchObject({ canceled: true, repState: 'na', written: false });

    // 리포트 목록과 같은 한 판정 — 같은 회차를 같은 낱말로 읽는다
    const reports = await api('get', `/reports?from=${past}&to=${past}`).expect(200);
    const stateOf = (serId: number) => (reports.body.items as Array<{ serId: number; state: string; written: boolean }>)
      .find((r) => r.serId === serId);
    expect(stateOf(plain.id)).toMatchObject({ state: 'na', written: false });
    expect(stateOf(written.id)).toMatchObject({ state: 'na', written: false });
  });

  /* ── A′2 — 회차의 장소 낱말 · 안내 자동 채움의 「형태」 (그 회차의 값 · 회차가 없으면 규칙) ───── */

  it('A′2 §43 「매번」 줄의 장소 — 그 회차만 온라인으로 바꾼 수업에 규칙의 강의실 이름을 붙이지 않는다', async () => {
    // 현장 규칙(강의실 A)인데 그 회차만 온라인(줌 Z1) — 투영의 강의실은 비어 있다
    const { toOnline } = await switchedToday();
    expect(await occAt(toOnline, TODAY)).toMatchObject({ room_id: null, zacc_id: String(Z1) });

    const guides = await api('get', '/guides').expect(200);
    const row = (guides.body.perLesson as Array<{ serId: number; roomName: string | null; zaccLabel: string | null }>)
      .find((l) => l.serId === toOnline);
    expect(row).toMatchObject({ roomName: null, zaccLabel: 'W11-Z1' });
  });

  it('A′2 회의 장소 — 그 회차만 바꾸며 붙인 줌 계정 · 고른 강의실을 적는다 (규칙이 아니라 그 회차의 투영)', async () => {
    const place = async () => (await api('get', `/ops/meetings/${MEET}`).expect(200)).body.placeLabel as string | null;

    // ① 현장 규칙(강의실 C)인데 그 회차만 온라인 + 줌 Z1
    const lesson = await makeSer({ fromDate: MON, rrule: 'ONCE', roomId: ROOM_C, startMin: 780, endMin: 840, studentIds: [] });
    await q(`INSERT INTO mtrec (id, mt_type, title, on_date, ser_id) VALUES ($1, 'general', 'W11 회의', $2::date, $3)`, [MEET, MON, lesson.id]);
    await q(`INSERT INTO mtattd (mt_id, staff_id) VALUES ($1, $2)`, [MEET, T1]);
    await api('patch', `/schedule/${lesson.id}`).send({ scope: 'this', onDate: MON, mode: 'online', zaccId: Z1 }).expect(200);
    expect(await place()).toBe('온라인 W11-Z1');
    const ops = await api('get', `/ops?from=${MON}&to=${MON}`).expect(200);
    expect((ops.body.meetings as Array<{ id: number; placeLabel: string | null }>).find((m) => m.id === MEET)?.placeLabel)
      .toBe('온라인 W11-Z1');
    await api('post', `/ops/meetings/${MEET}/notice`).expect(201);
    const [noti] = await q<{ body: string }>(`SELECT body FROM noti WHERE to_id = $1 AND link LIKE $2`, [T1, `%meeting=${MEET}`]);
    expect(noti.body).toContain('줌 W11-Z1');
    expect(noti.body).toContain('https://zoom.example/w11-1');

    // ② 온라인 규칙(규칙 줌 Z2)인데 그 회차만 현장 + 강의실 B — 같은 회의를 그 회차에 옮겨 건다
    const online = await makeSer({
      fromDate: MON, rrule: 'ONCE', mode: 'online', roomId: null, startMin: 900, endMin: 960, studentIds: [],
    });
    await api('post', '/zoom/assign').send({ serId: online.id, zaccId: Z2 }).expect(201);
    await api('patch', `/schedule/${online.id}`).send({ scope: 'this', onDate: MON, mode: 'offline', roomId: ROOM_B }).expect(200);
    await q(`UPDATE mtrec SET ser_id = $2 WHERE id = $1`, [MEET, online.id]);
    expect(await place()).toBe('위11-B');
  });

  it('A′2 안내 자동 채움의 「형태」 — 안내가 걸린 회차의 실제 방식 · 그 회차가 없으면 규칙의 방식', async () => {
    type Fact = { key: string; value: string | null };
    type Filled = { id: number; autoFill: { body: string; facts: Fact[] } | null };
    const modeOf = (g: Filled | undefined) => g?.autoFill?.facts.find((f) => f.key === 'mode')?.value;

    // 현장 규칙(강의실 A · 학생 A)인데 첫 수업 회차만 온라인
    const lesson = await makeSer({ fromDate: MON, rrule: 'ONCE' });
    await api('patch', `/schedule/${lesson.id}`).send({ scope: 'this', onDate: MON, mode: 'online', zaccId: null }).expect(200);
    const [occ] = await q<{ id: string }>(`SELECT id FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [lesson.id, MON]);
    const draft = (await api('post', '/guides/drafts').send({ sourceOccurrenceId: Number(occ.id), studentId: STU_A }).expect(201))
      .body as Filled;
    expect(modeOf(draft)).toBe('온라인');
    expect(draft.autoFill?.body).toContain('형태 온라인');
    const listed = async () => modeOf(((await api('get', '/guides').expect(200)).body.guides as Filled[]).find((g) => g.id === draft.id));

    // 투영이 없어도(호라이즌 밖과 같은 모양 — 투영 줄만 걷는다) 그 회차의 예외가 방식을 말한다
    await q(`DELETE FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [lesson.id, MON]);
    expect(await listed()).toBe('온라인');
    // 회차 자체가 없어지면(예외도 없다) 규칙의 방식(현장)이다
    await q(`DELETE FROM exc WHERE ser_id = $1 AND on_date = $2::date`, [lesson.id, MON]);
    expect(await listed()).toBe('현장');
  });

  /* ── A′3 — 안내 줄의 수업 이름표 · 회의 시각 · 되돌리기의 월 마감 ─────────────────────────── */

  /** 그 회차가 실제로 시작하는 시각(KST) — 투영 구간에서 읽는다 */
  const startOf = async (serId: number, onDate = MON) => (await q<{ s: string }>(
    `SELECT to_char(lower(span) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS s FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`,
    [serId, onDate],
  ))[0]?.s;

  it('A′3 안내 줄의 수업 이름표 — 그 회차만 온라인이면 규칙의 강의실을 붙이지 않는다 (§45 사건 · §43 할 일 · §44) · 회차가 없으면 규칙', async () => {
    type Tagged = { id?: number; serId: number | null; studentId: number; roomName: string | null };
    // 오늘 · 현장 규칙(강의실 A · 학생 A)인데 그 회차만 온라인(줌 Z1)
    const { toOnline } = await switchedToday();

    // §43 「안내 없음」 — §45 와 같은 사건 식(GUIDE_EVENT_CTE)의 첫 수업 줄
    const before = await api('get', '/guides').expect(200);
    const event = (before.body.missing as Tagged[]).find((m) => m.serId === toOnline && m.studentId === STU_A);
    expect(event).toBeDefined();
    expect(event?.roomName).toBeNull();

    // 초안을 만들면 §43 할 일 줄 · §44 학생별 줄이 같은 이름표를 싣는다
    const [occ] = await q<{ id: string }>(`SELECT id FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [toOnline, TODAY]);
    const draft = (await api('post', '/guides/drafts').send({ sourceOccurrenceId: Number(occ.id), studentId: STU_A }).expect(201))
      .body as Tagged;
    expect(draft.roomName).toBeNull();
    const students = await api('get', '/guides/students').expect(200);
    const mine = (students.body.items as Array<{ studentId: number; latestGuide: Tagged }>).find((s) => s.studentId === STU_A);
    expect(mine?.latestGuide.roomName).toBeNull();

    // 투영 줄이 없으면(호라이즌 밖과 같은 모양) 규칙의 강의실로 떨어진다 — 안내 줄은 회차를 LEFT JOIN 한다
    await q(`DELETE FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [toOnline, TODAY]);
    const after = await api('get', '/guides').expect(200);
    expect((after.body.guides as Tagged[]).find((g) => g.id === draft.id)?.roomName).toBe('위11-A');
  });

  it('A′3 회의 시각 — 그 회차만 시간을 옮기면 §63 줄 · §66 머리 · 안내 알림이 옮긴 시각을 적는다 · 투영이 없으면 규칙 시각', async () => {
    const lesson = await makeSer({ fromDate: MON, rrule: 'ONCE', roomId: ROOM_C, startMin: 780, endMin: 840, studentIds: [] });
    await q(`INSERT INTO mtrec (id, mt_type, title, on_date, ser_id) VALUES ($1, 'general', 'W11 회의', $2::date, $3)`, [MEET, MON, lesson.id]);
    await q(`INSERT INTO mtattd (mt_id, staff_id) VALUES ($1, $2)`, [MEET, T1]);
    await api('patch', `/schedule/${lesson.id}`).send({ scope: 'this', onDate: MON, startMin: 900, endMin: 960 }).expect(200);
    type Timed = { id: number; startMin: number | null; endMin: number | null };
    const detail = async () => (await api('get', `/ops/meetings/${MEET}`).expect(200)).body as Timed;

    expect(await detail()).toMatchObject({ startMin: 900, endMin: 960 });
    const ops = await api('get', `/ops?from=${MON}&to=${MON}`).expect(200);
    expect((ops.body.meetings as Timed[]).find((m) => m.id === MEET)).toMatchObject({ startMin: 900, endMin: 960 });
    await api('post', `/ops/meetings/${MEET}/notice`).expect(201);
    const [noti] = await q<{ body: string }>(`SELECT body FROM noti WHERE to_id = $1 AND link LIKE $2`, [T1, `%meeting=${MEET}`]);
    expect(noti.body).toContain('15:00–16:00');

    // 투영 줄이 없으면(호라이즌 밖과 같은 모양) 규칙의 시각
    await q(`DELETE FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [lesson.id, MON]);
    expect(await detail()).toMatchObject({ startMin: 780, endMin: 840 });
  });

  it('A′3 일정 되돌리기도 월 마감을 지난다 — 마감한 달의 회차를 되돌리면 409 MONTH_CLOSED · 그대로 · 해제하면 같은 토큰으로 되돌린다', async () => {
    const lesson = await makeSer({ fromDate: MON, rrule: 'ONCE' });
    const moved = await api('patch', `/schedule/${lesson.id}`).send({ scope: 'this', onDate: MON, startMin: 720, endMin: 780 }).expect(200);
    const token = moved.body.undoToken as string;
    expect(token).toEqual(expect.any(String));
    expect(await startOf(lesson.id)).toBe('12:00');

    const month = MON.slice(0, 7);
    await q(`INSERT INTO month_close (year_month, closed_by) VALUES ($1, $2)`, [month, CEO]);
    const refused = await api('post', '/schedule/undo').send({ token }).expect(409);
    expect(refused.body.code).toBe('MONTH_CLOSED');
    expect(await startOf(lesson.id)).toBe('12:00');

    // 해제하면(마감 줄은 남고 다시 열린다) 같은 토큰으로 되돌린다 — 막힌 되돌리기는 아무것도 남기지 않았다
    await q(
      `UPDATE month_close SET reopened_at = now(), reopened_by = $2, reopen_reason = 'W11 시험' WHERE year_month = $1 AND reopened_at IS NULL`,
      [month, CEO],
    );
    await api('post', '/schedule/undo').send({ token }).expect(201);
    expect(await startOf(lesson.id)).toBe('10:00');
  });

  it('A′3 반영한 변경 요청을 마감 뒤 되돌리면 409 MONTH_CLOSED — 요청도 시간표도 반영 그대로 (결재 되돌리기가 같은 판정을 탄다)', async () => {
    const lesson = await makeSer({ fromDate: MON, rrule: 'ONCE' });
    const [c] = await q<{ id: string }>(
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id)
       VALUES ($1, $2::date, 'time_move', '{"startMin":840,"endMin":900}'::jsonb, 'W11 옮겨 주세요', $3) RETURNING id`,
      [lesson.id, MON, T1],
    );
    const reviewed = await api('post', `/drawer/change-requests/${c.id}/review`).send({ decision: 'approve' }).expect(201);
    expect(await startOf(lesson.id)).toBe('14:00');

    await q(`INSERT INTO month_close (year_month, closed_by) VALUES ($1, $2)`, [MON.slice(0, 7), CEO]);
    const refused = await api('post', '/drawer/approvals/undo').send({ token: reviewed.body.undoToken }).expect(409);
    expect(refused.body.code).toBe('MONTH_CLOSED');
    const [row] = await q<{ state: string }>(`SELECT state FROM chreq WHERE id = $1`, [c.id]);
    expect(row.state).toBe('approved');
    expect(await startOf(lesson.id)).toBe('14:00');
  });

  /* ── N-142 「같은 시간에 두 사람이 수정 — 나중 저장이 반영된다 · 충돌 시 안내」 (사용자 결정 2026-09-30 · 막지 않고 알린다) ── */
  it('N-142 두 사람이 같은 목록을 읽고 고치면 나중 저장이 반영되고, 읽은 뒤 남이 고친 것을 덮어썼다고 알린다 · 새로 읽었거나 readVersion 이 없으면 알리지 않는다', async () => {
    const ADMIN2 = 989;
    await q(`DELETE FROM log WHERE actor_id = $1`, [ADMIN2]);
    await q(`DELETE FROM staff WHERE id = $1`, [ADMIN2]);
    await q(`INSERT INTO staff (id, name, email, role, password_hash, active) VALUES ($1,'W11관리자','w11-a2@t.kr','admin',$2,true)`,
      [ADMIN2, await bcrypt.hash(PW, 4)]);
    try {
      const adminToken = (await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId: 'w11-a2@t.kr', password: PW }).expect(201)).body.accessToken as string;
      const { id } = await makeSer();
      // 두 사람이 같은 목록을 읽었다 — 목록은 읽기 직전의 기록 번호를 준다
      const read = await api('get', `/schedule/occurrences?from=${MON}&to=${MON}`).expect(200);
      const v = read.body.version as number;
      expect(Number.isInteger(v)).toBe(true);
      // 관리자가 먼저 고친다 — 읽은 뒤 남의 기록이 없다
      const first = await api('patch', `/schedule/${id}`, adminToken)
        .send({ scope: 'all', onDate: MON, startMin: 630, endMin: 690, readVersion: v }).expect(200);
      expect(first.body.overwrote).toBeNull();
      // 대표가 옛 목록으로 저장 — 막지 않는다. 나중 저장이 반영되고, 관리자의 수정을 덮어썼다고 알린다
      const second = await api('patch', `/schedule/${id}`)
        .send({ scope: 'all', onDate: MON, startMin: 660, endMin: 720, readVersion: v }).expect(200);
      expect(second.body.overwrote).toEqual({ byName: 'W11관리자', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/) });
      expect(await startOf(id)).toBe('11:00');
      // 새로 읽고 고치면 알릴 것이 없다 · 자기 쓰기는 세지 않는다
      const v2 = (await api('get', `/schedule/occurrences?from=${MON}&to=${MON}`).expect(200)).body.version as number;
      expect(v2).toBeGreaterThan(v);
      const third = await api('patch', `/schedule/${id}`)
        .send({ scope: 'all', onDate: MON, startMin: 690, endMin: 750, readVersion: v2 }).expect(200);
      expect(third.body.overwrote).toBeNull();
      // readVersion 을 안 주면 보지 않는다(옛 화면 · 다른 경로)
      const fourth = await api('patch', `/schedule/${id}`, adminToken)
        .send({ scope: 'all', onDate: MON, startMin: 600, endMin: 660 }).expect(200);
      expect(fourth.body.overwrote).toBeNull();
      expect(await startOf(id)).toBe('10:00');
      await api('patch', `/schedule/${id}`).send({ scope: 'all', onDate: MON, startMin: 600, endMin: 660, readVersion: -1 }).expect(400);
    } finally {
      await q(`DELETE FROM log WHERE actor_id = $1`, [ADMIN2]);
      await q(`DELETE FROM noti WHERE to_id = $1 OR from_id = $1`, [ADMIN2]);
      await q(`DELETE FROM staff WHERE id = $1`, [ADMIN2]);
    }
  });
});
