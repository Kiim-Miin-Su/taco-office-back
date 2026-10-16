/** @file-guide
 * 목적: 10/14 PPTX p8 결정(2026-10-16) — 강사 가능 과목(SUB) 칩 저장과 학력 학위·상태 코드표의 HTTP→DB 회귀.
 * 책임/재사용: 실제 AppModule·운영과 같은 ValidationPipe·격리 DB로 돈다. 이 스위트 전용 staff 8871~8873, `s5b-subj-` 아이디·과목만 만든다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
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
jest.setTimeout(90_000);

/**
 * 사용자 결정(2026-10-16): p8 「가능 과목」은 PPTX대로 수업·모의수업·자습으로 묶은 실제 과목(SUB) 칩이다(GPA 제외).
 * 학력 학위는 전문학사·학사·석사·박사·기타, 상태는 재학·휴학·수료·졸업·중퇴 서버 코드표 — 기존 자유 입력 값은 그대로 읽고,
 * 같은 사람의 저장값을 다시 보낼 때만 통과시킨다. migration 127의 수업 유형(kind) 행은 과목으로 바꾸지 않고 읽기 전용으로 남긴다(N-25).
 */
d('p8 결정 — 가능 과목 SUB 칩 · 학력 코드표 (HTTP/DB)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 's5b-subj-fixture-1234';
  const TEMP = 'Temp-pass-s5b1';
  const CEO = 8871;
  const MGR = 8872;
  const TEACHER = 8873;
  const ids = [CEO, MGR, TEACHER];
  const SUB = { cls: 's5bs-cls', mck: 's5bs-mck', std: 's5bs-std', old: 's5bs-old' } as const;
  const tokens: Record<string, string> = {};

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'get' | 'post' | 'patch', url: string, token = tokens.mgr) =>
    (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[m](url)
      .timeout({ response: 8000, deadline: 15000 })
      .set('Authorization', `Bearer ${token}`);
  const login = async (loginId: string) =>
    (await request(app.getHttpServer()).post('/auth/login').send({ loginId, password: PW }).expect(201)).body.accessToken as string;
  const subjectsOf = async (staffId: number) =>
    (await q<{ sub_key: string }>(`SELECT sub_key FROM staff_teaching_subject WHERE staff_id = $1 ORDER BY sub_key`, [staffId]))
      .map((row) => row.sub_key);

  const dropMade = async () => {
    const rows = await q<{ id: string }>(`SELECT id FROM staff WHERE lower(login_id) LIKE 's5b-subj-new-%'`);
    for (const r of rows) {
      await q(`DELETE FROM wage WHERE staff_id = $1`, [r.id]);
      await q(`DELETE FROM auth_code WHERE staff_id = $1`, [r.id]);
      await q(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = $1`, [r.id]);
      await q(`DELETE FROM staff WHERE id = $1`, [r.id]);
    }
  };
  const dropFixtures = async () => {
    await q(`DELETE FROM log WHERE actor_id = ANY($1) OR (entity = 'STAFF' AND entity_id = ANY($1))`, [ids]);
    await q(`DELETE FROM auth_code WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
    await q(`DELETE FROM sub WHERE key = ANY($1)`, [Object.values(SUB)]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await dropMade();
    await dropFixtures();
    for (const [key, name, sort] of [['class', '수업', 1], ['mock', '모의수업', 2], ['study', '자습', 4]] as const) {
      await q(`INSERT INTO kind(key,name,color,cap,grp,rep,sort) VALUES($1,$2,'#4A7FB5',4,'lesson',true,$3) ON CONFLICT (key) DO NOTHING`, [key, name, sort]);
    }
    await q(`INSERT INTO sub(key,name,color,active,sort,kind_key) VALUES
      ($1,'S5B 수업 과목','#4A7FB5',true,901,'class'),
      ($2,'S5B 모의 과목','#4A7FB5',true,902,'mock'),
      ($3,'S5B 자습 과목','#4A7FB5',true,903,'study'),
      ($4,'S5B 끈 과목','#4A7FB5',false,904,'class')`, [SUB.cls, SUB.mck, SUB.std, SUB.old]);
    const hash = await bcrypt.hash(PW, 4);
    await q(`INSERT INTO staff (id,name,login_id,role,password_hash,active,must_change_credentials) VALUES
      ($1,'과목대표','s5b-subj-ceo','ceo',$4,true,false),
      ($2,'과목매니저','s5b-subj-mgr','manager',$4,true,false),
      ($3,'과목강사','s5b-subj-t','teacher',$4,true,false)`, [CEO, MGR, TEACHER, hash]);
    await q(`INSERT INTO tzg (id, name, tz) VALUES (1,'한국 (KST)','Asia/Seoul') ON CONFLICT (id) DO NOTHING`);
    tokens.mgr = await login('s5b-subj-mgr');
    tokens.teacher = await login('s5b-subj-t');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) { await dropMade(); await dropFixtures(); }
    } finally {
      await app?.close();
    }
  });

  it('서랍이 고를 수 있는 과목 묶음과 학력 코드표를 준다 — 수업·모의수업·자습만, GPA·상담·끈 과목 없음', async () => {
    const body = (await api('get', '/drawer').expect(200)).body as {
      teachingSubjectGroups: Array<{ kindKey: string; kindName: string; subjects: Array<{ key: string; name: string }> }>;
      educationDegrees: string[]; educationStatuses: string[];
    };
    expect(body.teachingSubjectGroups.map((group) => group.kindKey)).toEqual(['class', 'mock', 'study']);
    const keys = body.teachingSubjectGroups.flatMap((group) => group.subjects.map((subject) => subject.key));
    expect(keys).toEqual(expect.arrayContaining([SUB.cls, SUB.mck, SUB.std]));
    expect(keys).not.toContain(SUB.old);
    expect(keys).not.toContain('gpa-care');
    expect(keys).not.toContain('intake');
    expect(body.educationDegrees).toEqual(['전문학사', '학사', '석사', '박사', '기타']);
    expect(body.educationStatuses).toEqual(['재학', '휴학', '수료', '졸업', '중퇴']);
  });

  it('강사 만들기 — 과목 칩을 저장하고 서랍·상세·DB가 같은 과목을 다시 읽는다', async () => {
    const made = await api('post', '/drawer/staff').send({
      name: '과목 신규', loginId: 's5b-subj-new-1', password: TEMP, role: 'teacher',
      teachingSubjectKeys: [SUB.std, SUB.cls, SUB.mck],
      education: [{ school: '연세대학교', major: '영어영문학', degree: '학사', status: '졸업' }],
    }).expect(201);
    const id = Number(made.body.id);
    expect(await subjectsOf(id)).toEqual([SUB.cls, SUB.mck, SUB.std].sort());
    const member = ((await api('get', '/drawer').expect(200)).body.members as Array<Record<string, unknown>>)
      .find((row) => row.id === id)!;
    // 묶음 차례(수업 → 모의수업 → 자습) · 과목 이름과 종류 이름은 서버가 준다
    expect(member.teachingSubjects).toEqual([
      { key: SUB.cls, name: 'S5B 수업 과목', kindKey: 'class', kindName: '수업' },
      { key: SUB.mck, name: 'S5B 모의 과목', kindKey: 'mock', kindName: '모의수업' },
      { key: SUB.std, name: 'S5B 자습 과목', kindKey: 'study', kindName: '자습' },
    ]);
    expect(member.education).toEqual([{ school: '연세대학교', major: '영어영문학', degree: '학사', status: '졸업' }]);
    const detail = (await api('get', `/drawer/staff-directory/${id}`).expect(200)).body as {
      profile: { teachingSubjects: Array<{ key: string }>; teachingSubjectCount: number };
    };
    expect(detail.profile.teachingSubjectCount).toBe(3);
    expect(detail.profile.teachingSubjects.map((subject) => subject.key)).toEqual([SUB.cls, SUB.mck, SUB.std]);
  });

  it('GPA·상담 과목·없는 과목·꺼 둔 과목은 400 이고 아무것도 만들지 않는다 · 옛 수업 유형 필드는 받지 않는다', async () => {
    for (const keys of [['gpa-care'], ['intake'], ['s5bs-none'], [SUB.old]]) {
      const res = await api('post', '/drawer/staff').send({
        name: '과목 거절', loginId: 's5b-subj-new-bad', password: TEMP, role: 'teacher', teachingSubjectKeys: keys,
      }).expect(400);
      expect(res.body.code).toBe('STAFF_TEACHING_SUBJECT');
      expect(await q(`SELECT id FROM staff WHERE login_id = 's5b-subj-new-bad'`)).toEqual([]);
    }
    await api('post', '/drawer/staff').send({
      name: '옛 필드', loginId: 's5b-subj-new-kind', password: TEMP, role: 'teacher', teachingKindKeys: ['class'],
    }).expect(400);
    const res = await api('post', '/drawer/staff').send({
      name: '매니저 과목', loginId: 's5b-subj-new-mgr', password: TEMP, role: 'manager', teachingSubjectKeys: [],
    }).expect(400);
    expect(res.body.code).toBe('STAFF_TEACHING_ROLE');
  });

  it('DB가 마지막으로 막는다 — 수업·모의수업·자습 밖 과목 행은 직접 SQL로도 못 넣는다', async () => {
    for (const key of ['gpa-care', 'intake']) {
      await expect(q(`INSERT INTO staff_teaching_subject(staff_id, sub_key) VALUES ($1, $2)`, [TEACHER, key]))
        .rejects.toMatchObject({ driverError: { code: '23514', constraint: 'staff_teaching_subject_kind' } });
    }
    expect(await subjectsOf(TEACHER)).toEqual([]);
  });

  it('수정 — 과목 전체 대체·바뀐 칸만 감사 · migration 127 수업 유형 행은 바꾸지 않고 읽기 전용으로 남는다', async () => {
    await q(`INSERT INTO staff_teaching_kind(staff_id, kind_key) VALUES ($1,'class'),($1,'mock')`, [TEACHER]);
    await api('patch', `/drawer/staff/${TEACHER}`).send({ teachingSubjectKeys: [SUB.mck] }).expect(200);
    expect(await subjectsOf(TEACHER)).toEqual([SUB.mck]);
    const kinds = await q<{ kind_key: string }>(`SELECT kind_key FROM staff_teaching_kind WHERE staff_id = $1 ORDER BY kind_key`, [TEACHER]);
    expect(kinds.map((row) => row.kind_key)).toEqual(['class', 'mock']);
    const [log] = await q<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'update' ORDER BY id DESC LIMIT 1`, [TEACHER]);
    expect(Object.keys(log.after)).toEqual(['teachingSubjectKeys']);
    const member = ((await api('get', '/drawer').expect(200)).body.members as Array<Record<string, unknown>>)
      .find((row) => row.id === TEACHER)!;
    expect(member.teachingSubjects).toEqual([{ key: SUB.mck, name: 'S5B 모의 과목', kindKey: 'mock', kindName: '모의수업' }]);
    expect((member.teachingKinds as Array<{ key: string }>).map((kind) => kind.key)).toEqual(['class', 'mock']);
    // 같은 과목을 다시 보내면 바뀐 것이 없다
    await api('patch', `/drawer/staff/${TEACHER}`).send({ teachingSubjectKeys: [SUB.mck] }).expect(409);
  });

  it('꺼 둔 과목은 이미 가진 강사만 그대로 다시 보낼 수 있다 — 새로 고르면 400', async () => {
    await q(`INSERT INTO staff_teaching_subject(staff_id, sub_key) VALUES ($1, $2)`, [TEACHER, SUB.old]);
    await api('patch', `/drawer/staff/${TEACHER}`).send({ teachingSubjectKeys: [SUB.old, SUB.cls] }).expect(200);
    expect(await subjectsOf(TEACHER)).toEqual([SUB.cls, SUB.old].sort());
    const made = await api('post', '/drawer/staff').send({
      name: '과목 신규2', loginId: 's5b-subj-new-2', password: TEMP, role: 'teacher',
    }).expect(201);
    const res = await api('patch', `/drawer/staff/${Number(made.body.id)}`).send({ teachingSubjectKeys: [SUB.old] }).expect(400);
    expect(res.body.code).toBe('STAFF_TEACHING_SUBJECT');
  });

  it('학력 학위·상태 — 코드표 밖 새 값은 400 · 저장된 자유 입력 값은 그대로 읽고 다시 보내도 통과한다', async () => {
    const bad = await api('post', '/drawer/staff').send({
      name: '학위 거절', loginId: 's5b-subj-new-edu', password: TEMP, role: 'teacher',
      education: [{ school: '고려대학교', degree: '공학사' }],
    }).expect(400);
    expect(bad.body.code).toBe('STAFF_EDUCATION_CODE');
    expect(await q(`SELECT id FROM staff WHERE login_id = 's5b-subj-new-edu'`)).toEqual([]);
    const badStatus = await api('patch', `/drawer/staff/${TEACHER}`).send({
      education: [{ school: '고려대학교', degree: '학사', status: '졸업 예정' }],
    }).expect(400);
    expect(badStatus.body.code).toBe('STAFF_EDUCATION_CODE');

    // migration 127 시절 자유 입력으로 남은 값 — 고치지 않고 읽는다
    await q(`DELETE FROM staff_education_summary WHERE staff_id = $1`, [TEACHER]);
    await q(`INSERT INTO staff_education_summary(staff_id,position,school,major,degree,status) VALUES ($1,0,'KAIST','화학','공학사','졸업 예정')`, [TEACHER]);
    const member = ((await api('get', '/drawer').expect(200)).body.members as Array<Record<string, unknown>>)
      .find((row) => row.id === TEACHER)!;
    expect(member.education).toEqual([{ school: 'KAIST', major: '화학', degree: '공학사', status: '졸업 예정' }]);
    // 옛 값 줄은 그대로 두고 둘째 줄만 더한다 — 같은 사람의 저장값이라 통과
    await api('patch', `/drawer/staff/${TEACHER}`).send({ education: [
      { school: 'KAIST', major: '화학', degree: '공학사', status: '졸업 예정' },
      { school: '서울대학교', degree: '석사', status: '수료' },
    ] }).expect(200);
    const rows = await q(`SELECT school, degree, status FROM staff_education_summary WHERE staff_id = $1 ORDER BY position`, [TEACHER]);
    expect(rows).toEqual([
      { school: 'KAIST', degree: '공학사', status: '졸업 예정' },
      { school: '서울대학교', degree: '석사', status: '수료' },
    ]);
    // 옛 값을 다른 자유 입력으로 바꾸려 하면 400
    await api('patch', `/drawer/staff/${TEACHER}`).send({ education: [{ school: 'KAIST', degree: '이학사' }] }).expect(400);
  });

  it('강사 본인 서랍에는 과목도 학력도 싣지 않는다(서버 projection)', async () => {
    const own = ((await api('get', '/drawer', tokens.teacher).expect(200)).body.members as Array<Record<string, unknown>>)
      .find((row) => row.id === TEACHER)!;
    expect(own).toMatchObject({ teachingSubjects: [], teachingKinds: [], education: [] });
  });
});
