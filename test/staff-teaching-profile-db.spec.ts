/** @file-guide
 * 목적: BO-1014-STAFF 수업 프로필의 실제 HTTP→DB 재조회·권한·삭제 회귀.
 * 책임/재사용: 로컬 격리 스크래치에서 이 스위트가 만든 행만 정리한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { todayKst } from '../src/lib/kst';
import { assertScratch, DEV_URL, TEST_URL } from './db';

const d = process.env.BO1014_DB_TEST === '1' ? describe : describe.skip;
jest.setTimeout(90_000);

d('BO-1014-STAFF · 격리 DB 수업 프로필', () => {
  let app: INestApplication;
  let ds: DataSource;
  let managerId: number | null = null;
  let teacherId: number | null = null;
  let managerToken = '';
  const madeKinds: string[] = [];
  let madeTzgId: number | null = null;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const managerLogin = `bo1014-staff-manager-${stamp}`;
  const teacherLogin = `bo1014-staff-teacher-${stamp}`;
  const password = 'Test-password-1014';
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params) as Promise<T[]>;
  const auth = (method: 'get' | 'post' | 'patch' | 'delete', path: string, token = managerToken) =>
    (request(app.getHttpServer()) as unknown as Record<string, (url: string) => request.Test>)[method](path)
      .timeout({ response: 8000, deadline: 15000 })
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    // 이 스위트는 사용자가 승인한 로컬 taco_dev_test 외에는 연결 자체를 시작하지 않는다.
    const scratch = assertScratch(TEST_URL);
    const url = new URL(scratch);
    if (DEV_URL !== TEST_URL || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.port !== '55494' || url.pathname !== '/taco_dev_test') {
      throw new Error('BO-1014-STAFF DB 시험 대상이 승인된 localhost:55494/taco_dev_test와 다릅니다');
    }
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    const [identity] = await q<{ db: string; port: number }>('SELECT current_database() AS db, inet_server_port() AS port');
    expect(identity).toEqual({ db: 'taco_dev_test', port: 55494 });

    const [tzg] = await q<{ id: string }>(`SELECT id FROM tzg WHERE tz='Asia/Seoul' LIMIT 1`);
    if (!tzg) {
      const [made] = await q<{ id: string }>(`INSERT INTO tzg(name,tz) VALUES('BO-1014 KST','Asia/Seoul') RETURNING id`);
      madeTzgId = Number(made.id);
    }
    for (const [key, name, sort] of [['class', '수업', 1], ['mock', '모의수업', 2], ['study', '자습', 3]] as const) {
      const [made] = await q<{ key: string }>(
        `INSERT INTO kind(key,name,color,cap,grp,rep,sort) VALUES($1,$2,'#445566',4,'lesson',true,$3)
         ON CONFLICT (key) DO NOTHING RETURNING key`, [key, name, sort],
      );
      if (made) madeKinds.push(made.key);
    }
    const hash = await bcrypt.hash(password, 4);
    const [manager] = await q<{ id: string }>(
      `INSERT INTO staff(name,login_id,role,password_hash,active,must_change_credentials)
       VALUES('BO-1014 관리자',$1,'manager',$2,true,false) RETURNING id`, [managerLogin, hash],
    );
    managerId = Number(manager.id);
    const login = await request(app.getHttpServer()).post('/auth/login').send({ loginId: managerLogin, password }).expect(201);
    managerToken = login.body.accessToken as string;
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        // API 삭제가 실패해도 이 스위트가 만든 계정/로그만 정리한다.
        if (teacherId !== null) {
          await q(`DELETE FROM log WHERE actor_id=$1 OR (entity='STAFF' AND entity_id=$1)`, [teacherId]);
          await q(`DELETE FROM auth_code WHERE staff_id=$1`, [teacherId]);
          await q(`DELETE FROM staff WHERE id=$1`, [teacherId]);
        }
        if (managerId !== null) {
          await q(`DELETE FROM log WHERE actor_id=$1 OR (entity='STAFF' AND entity_id=$1)`, [managerId]);
          await q(`DELETE FROM auth_code WHERE staff_id=$1`, [managerId]);
          await q(`DELETE FROM staff WHERE id=$1`, [managerId]);
        }
        for (const key of madeKinds) await q(`DELETE FROM kind WHERE key=$1`, [key]);
        if (madeTzgId !== null) await q(`DELETE FROM tzg WHERE id=$1`, [madeTzgId]);
      }
    } finally {
      await app?.close();
    }
  });

  it('강사 생성→상세/서랍/DB 재조회→수정→재조회→삭제 시 프로필 자식 행도 삭제한다', async () => {
    const made = await auth('post', '/drawer/staff').send({
      name: 'BO-1014 강사', loginId: teacherLogin, password, role: 'teacher', hiredOn: '2020-01-01',
      birthOn: '1990-01-02', englishOnly: true, teachingKindKeys: ['class', 'mock'],
      education: [{ school: '첫 학교', major: '수학' }, { school: '둘째 학교', degree: '학사' }],
    }).expect(201);
    teacherId = Number(made.body.id);
    expect(made.body).toMatchObject({ birthOn: '1990-01-02', englishOnly: true,
      teachingKinds: [{ key: 'class' }, { key: 'mock' }],
      education: [{ school: '첫 학교', major: '수학' }, { school: '둘째 학교', degree: '학사' }] });

    const detail = (await auth('get', `/drawer/staff-directory/${teacherId}`).expect(200)).body;
    expect(detail.profile).toMatchObject({ id: teacherId, birthOn: '1990-01-02', englishOnly: true, teachingKindCount: 2 });
    const drawer = (await auth('get', '/drawer').expect(200)).body;
    expect(drawer.members.find((row: { id: number }) => row.id === teacherId)).toMatchObject({
      canViewStaffProfile: true, birthOn: '1990-01-02', englishOnly: true,
    });
    const [stored] = await q<{ birth_on: string; english_only: boolean }>(
      `SELECT to_char(birth_on,'YYYY-MM-DD') AS birth_on, english_only FROM staff WHERE id=$1`, [teacherId]);
    expect(stored).toEqual({ birth_on: '1990-01-02', english_only: true });
    expect(await q(`SELECT kind_key FROM staff_teaching_kind WHERE staff_id=$1 ORDER BY kind_key`, [teacherId]))
      .toEqual([{ kind_key: 'class' }, { kind_key: 'mock' }]);
    expect(await q(`SELECT school FROM staff_education_summary WHERE staff_id=$1 ORDER BY position`, [teacherId]))
      .toEqual([{ school: '첫 학교' }, { school: '둘째 학교' }]);

    await auth('patch', `/drawer/staff/${teacherId}`).send({
      birthOn: '1991-03-04', englishOnly: false, teachingKindKeys: ['study'],
      education: [{ school: '새 학교', status: '졸업' }],
    }).expect(200);
    const reread = (await auth('get', `/drawer/staff-directory/${teacherId}`).expect(200)).body;
    expect(reread.profile).toMatchObject({ birthOn: '1991-03-04', englishOnly: false, teachingKindCount: 1,
      teachingKinds: [{ key: 'study' }], education: [{ school: '새 학교', status: '졸업' }] });
    expect(await q(`SELECT kind_key FROM staff_teaching_kind WHERE staff_id=$1`, [teacherId])).toEqual([{ kind_key: 'study' }]);
    expect(await q(`SELECT school FROM staff_education_summary WHERE staff_id=$1`, [teacherId])).toEqual([{ school: '새 학교' }]);

    await auth('delete', `/drawer/staff/${teacherId}`).expect(200).expect(({ body }) => expect(body).toEqual({ ok: true }));
    expect(await q(`SELECT id FROM staff WHERE id=$1`, [teacherId])).toEqual([]);
    expect(await q(`SELECT staff_id FROM staff_teaching_kind WHERE staff_id=$1`, [teacherId])).toEqual([]);
    expect(await q(`SELECT staff_id FROM staff_education_summary WHERE staff_id=$1`, [teacherId])).toEqual([]);
    teacherId = null;
  });

  it('PATCH에서 생략한 프로필은 유지하고 null·빈 배열은 HTTP와 DB에서 비운다', async () => {
    const made = await auth('post', '/drawer/staff').send({
      name: '부분 수정 검증', loginId: `${teacherLogin}-patch`, password, role: 'teacher', hiredOn: '2020-01-01',
      birthOn: '1990-01-02', englishOnly: true, teachingKindKeys: ['class', 'mock'],
      education: [{ school: '보존 학교', major: '수학' }],
    }).expect(201);
    teacherId = Number(made.body.id);
    await auth('patch', `/drawer/staff/${teacherId}`).send({ title: '프로필 유지' }).expect(200);
    const retained = (await auth('get', `/drawer/staff-directory/${teacherId}`).expect(200)).body.profile;
    expect(retained).toMatchObject({ birthOn: '1990-01-02', englishOnly: true,
      teachingKinds: [{ key: 'class' }, { key: 'mock' }], education: [{ school: '보존 학교', major: '수학' }] });
    expect(await q(`SELECT to_char(birth_on,'YYYY-MM-DD') AS birth_on, english_only FROM staff WHERE id=$1`, [teacherId]))
      .toEqual([{ birth_on: '1990-01-02', english_only: true }]);
    expect(await q(`SELECT kind_key FROM staff_teaching_kind WHERE staff_id=$1 ORDER BY kind_key`, [teacherId]))
      .toEqual([{ kind_key: 'class' }, { kind_key: 'mock' }]);
    expect(await q(`SELECT school,major FROM staff_education_summary WHERE staff_id=$1`, [teacherId]))
      .toEqual([{ school: '보존 학교', major: '수학' }]);

    await auth('patch', `/drawer/staff/${teacherId}`).send({
      birthOn: null, englishOnly: null, teachingKindKeys: [], education: [],
    }).expect(200);
    const cleared = (await auth('get', `/drawer/staff-directory/${teacherId}`).expect(200)).body.profile;
    expect(cleared).toMatchObject({ birthOn: null, englishOnly: null, teachingKinds: [], education: [] });
    expect(await q(`SELECT birth_on,english_only FROM staff WHERE id=$1`, [teacherId]))
      .toEqual([{ birth_on: null, english_only: null }]);
    expect(await q(`SELECT staff_id FROM staff_teaching_kind WHERE staff_id=$1`, [teacherId])).toEqual([]);
    expect(await q(`SELECT staff_id FROM staff_education_summary WHERE staff_id=$1`, [teacherId])).toEqual([]);
    await auth('delete', `/drawer/staff/${teacherId}`).expect(200);
    teacherId = null;
  });

  it('매니저에서 강사로 전환하며 명시한 빈 배열은 숨겨 두었던 프로필 관계도 비운다', async () => {
    const made = await auth('post', '/drawer/staff').send({
      name: '재전환 비움 검증', loginId: `${teacherLogin}-restore`, password, role: 'teacher',
      teachingKindKeys: ['class'], education: [{ school: '이전 학교' }],
    }).expect(201);
    teacherId = Number(made.body.id);
    await auth('patch', `/drawer/staff/${teacherId}`).send({ role: 'manager' }).expect(200);
    // 비강사 응답에서 숨기는 것과 저장값을 지우는 것은 다르다. 재전환의 명시적 []는 실제 관계를 비워야 한다.
    expect(await q(`SELECT kind_key FROM staff_teaching_kind WHERE staff_id=$1`, [teacherId]))
      .toEqual([{ kind_key: 'class' }]);
    expect(await q(`SELECT school FROM staff_education_summary WHERE staff_id=$1`, [teacherId]))
      .toEqual([{ school: '이전 학교' }]);
    await auth('patch', `/drawer/staff/${teacherId}`).send({ role: 'teacher', teachingKindKeys: [], education: [] }).expect(200);
    const restored = (await auth('get', `/drawer/staff-directory/${teacherId}`).expect(200)).body.profile;
    expect(restored).toMatchObject({ teachingKinds: [], education: [] });
    expect(await q(`SELECT staff_id FROM staff_teaching_kind WHERE staff_id=$1`, [teacherId])).toEqual([]);
    expect(await q(`SELECT staff_id FROM staff_education_summary WHERE staff_id=$1`, [teacherId])).toEqual([]);
    await auth('delete', `/drawer/staff/${teacherId}`).expect(200);
    teacherId = null;
  });

  it('비강사 생성·역할 변경의 강사 프로필 입력을 400으로 막는다', async () => {
    for (const role of ['manager', 'admin'] as const) {
      const res = await auth('post', '/drawer/staff').send({
        name: '프로필 거절', loginId: `${teacherLogin}-${role}`, password, role, teachingKindKeys: [],
      }).expect(400);
      expect(res.body.code).toBe('STAFF_TEACHING_ROLE');
      expect(await q(`SELECT id FROM staff WHERE login_id=$1`, [`${teacherLogin}-${role}`])).toEqual([]);
    }
    const made = await auth('post', '/drawer/staff').send({
      name: '전환 검증 강사', loginId: `${teacherLogin}-role`, password, role: 'teacher', birthOn: '1990-01-01',
    }).expect(201);
    teacherId = Number(made.body.id);
    const rejected = await auth('patch', `/drawer/staff/${teacherId}`)
      .send({ role: 'manager', englishOnly: null }).expect(400);
    expect(rejected.body.code).toBe('STAFF_TEACHING_ROLE');
    expect(await q(`SELECT role::text AS role FROM staff WHERE id=$1`, [teacherId])).toEqual([{ role: 'teacher' }]);
  });

  it('생년월일이 오늘 또는 입사일과 같으면 생성·수정을 400으로 막고 저장값을 보존한다', async () => {
    const today = todayKst();
    for (const [suffix, birthOn, hiredOn] of [['today', today, today], ['hire', '1990-01-01', '1990-01-01']] as const) {
      const loginId = `${teacherLogin}-${suffix}`;
      try {
        const res = await auth('post', '/drawer/staff').send({
          name: '경계 거절 강사', loginId, password, role: 'teacher', birthOn, hiredOn,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('STAFF_BIRTH_DATE');
        expect(await q(`SELECT id FROM staff WHERE login_id=$1`, [loginId])).toEqual([]);
      } finally {
        // 경계가 다시 깨져도 이 시험이 만든 격리 DB 계정은 남기지 않는다.
        const [created] = await q<{ id: string }>(`SELECT id FROM staff WHERE login_id=$1`, [loginId]);
        if (created) {
          await q(`DELETE FROM log WHERE actor_id=$1 OR (entity='STAFF' AND entity_id=$1)`, [created.id]);
          await q(`DELETE FROM auth_code WHERE staff_id=$1`, [created.id]);
          await q(`DELETE FROM staff WHERE id=$1`, [created.id]);
        }
      }
    }
    expect(teacherId).not.toBeNull();
    const before = await q(`SELECT to_char(birth_on,'YYYY-MM-DD') AS birth_on, to_char(hired_on,'YYYY-MM-DD') AS hired_on FROM staff WHERE id=$1`, [teacherId]);
    for (const body of [{ birthOn: today }, { birthOn: '1990-01-01', hiredOn: '1990-01-01' }]) {
      const res = await auth('patch', `/drawer/staff/${teacherId}`).send(body).expect(400);
      expect(res.body.code).toBe('STAFF_BIRTH_DATE');
      expect(await q(`SELECT to_char(birth_on,'YYYY-MM-DD') AS birth_on, to_char(hired_on,'YYYY-MM-DD') AS hired_on FROM staff WHERE id=$1`, [teacherId]))
        .toEqual(before);
    }
  });

  it('가능 수업 유형·학력 배열의 명시적 null은 생성과 수정에서 400이며 행을 바꾸지 않는다', async () => {
    expect(teacherId).not.toBeNull();
    for (const field of ['teachingKindKeys', 'education'] as const) {
      const loginId = `${teacherLogin}-null-${field}`;
      await auth('post', '/drawer/staff').send({
        name: '배열 null 거절', loginId, password, role: 'teacher', [field]: null,
      }).expect(400);
      expect(await q(`SELECT id FROM staff WHERE login_id=$1`, [loginId])).toEqual([]);
      await auth('patch', `/drawer/staff/${teacherId}`).send({ [field]: null }).expect(400);
    }
    expect(await q(`SELECT to_char(birth_on,'YYYY-MM-DD') AS birth_on FROM staff WHERE id=$1`, [teacherId]))
      .toEqual([{ birth_on: '1990-01-01' }]);
  });

  it('GET /drawer의 비관리자 구성원 projection에서 생년월일·영어·수업 유형·학력을 서버가 제거한다', async () => {
    expect(teacherId).not.toBeNull();
    await q(`UPDATE staff SET must_change_credentials=false WHERE id=$1`, [teacherId]);
    const login = await request(app.getHttpServer()).post('/auth/login')
      .send({ loginId: `${teacherLogin}-role`, password }).expect(201);
    const teacherToken = login.body.accessToken as string;
    const own = (await auth('get', '/drawer', teacherToken).expect(200)).body.members;
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: teacherId, canViewStaffProfile: false,
      birthOn: null, englishOnly: null, teachingKinds: [], education: [] });

    // canCrudAll=true, canAdminPage=false 조합이 생겨도 SELECT 단계에서 민감 필드가 빠져야 한다.
    const broadRead = await app.get(DrawerService).all(managerId!, false, true, false, 'none', false, false);
    const row = broadRead.members.find((member) => member.id === teacherId);
    expect(row).toMatchObject({ canViewStaffProfile: false, birthOn: null, englishOnly: null,
      teachingKinds: [], education: [] });
  });

  it('강사를 매니저로 변경하면 보존된 프로필을 관리자 서랍에도 표시하지 않는다', async () => {
    expect(teacherId).not.toBeNull();
    await auth('patch', `/drawer/staff/${teacherId}`).send({ role: 'manager' }).expect(200);
    const members = (await auth('get', '/drawer').expect(200)).body.members;
    expect(members.find((row: { id: number }) => row.id === teacherId)).toMatchObject({
      role: 'manager', canViewStaffProfile: false, birthOn: null, englishOnly: null,
      teachingKinds: [], education: [],
    });
  });
});
