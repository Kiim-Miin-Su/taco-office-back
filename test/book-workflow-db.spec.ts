/** @file-guide
 * 목적: §38 ISSUE·§39 LIB·§41 GPAPACK의 실제 Postgres 저장·제약·전이를 검증한다.
 * 책임/재사용: BooksService의 공개 쓰기/읽기만 호출하며 스크래치 DB 트랜잭션 밖에 행을 남기지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BooksService } from '../src/modules/books/books.service';
import { BookPatchDto } from '../src/modules/books/books.dto';
import { BookWorkflow1759700000000 } from '../src/migrations/1759700000000-book-workflow';
import { todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
/**
 * 자료 묶음의 적용일 — **오늘(KST)로 잡는다.**
 *
 * `replacePackBooks` 는 「적용일에 유효한 판」을 고르는데(`from_date <= 적용일`) `addVersion` 은
 * `from_date` 를 **오늘**로 새긴다. 고정 날짜를 적어 두면 그날이 지나는 순간 판이 하나도 안 잡혀
 * `versId`·`seFileId` 가 조용히 null 이 된다(2026-09-21 실측). 달력 때문에 깨지는 시험을 남기지 않는다.
 */
const EFFECTIVE_ON = todayKst();
jest.setTimeout(60_000);

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

d('§38·§41 교재 저장 수직 계약 (C77)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let studentA: number;
  let studentB: number;
  let libA: number;
  let libB: number;
  const owner = 1771;
  const coordinator = 1772;
  const deniedCoordinator = 1773;
  const teacherOverride = 1774;
  const managerRecipient = 1775;
  const svc = () => new BooksService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role,active,can_gpa_pack) VALUES
      ($1,'교재 담당','book-owner@test','admin',true,NULL),
      ($2,'수령 코디','book-coord@test','manager',true,NULL),
      ($3,'수령 금지 코디','book-denied@test','manager',true,false),
      ($4,'자료 권한 강사','book-teacher-override@test','teacher',true,true),
      ($5,'자료 알림 매니저','book-manager-recipient@test','manager',true,true)
      ON CONFLICT (id) DO NOTHING`, [owner, coordinator, deniedCoordinator, teacherOverride, managerRecipient]);
    const [a] = await q.query(`INSERT INTO stu (name,grade) VALUES ('교재 학생 A','G9') RETURNING id`);
    const [b] = await q.query(`INSERT INTO stu (name,grade) VALUES ('교재 학생 B','G10') RETURNING id`);
    studentA = Number(a.id); studentB = Number(b.id);
    const [la] = await q.query(`INSERT INTO lib (code,title,pages) VALUES ($1,'교재 A',100) RETURNING id`, [`C77-A-${studentA}`]);
    const [lb] = await q.query(`INSERT INTO lib (code,title,pages) VALUES ($1,'교재 B',200) RETURNING id`, [`C77-B-${studentB}`]);
    libA = Number(la.id); libB = Number(lb.id);
  });
  afterEach(async () => { if (q?.isTransactionActive) await q.rollbackTransaction(); if (q && !q.isReleased) await q.release(); });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('선택 정보를 null로 지우면 재조회와 LOG에 남고 기존 진도 쪽수는 보존한다', async () => {
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('t52-book','교재 검수','#123456') ON CONFLICT (key) DO NOTHING`);
    await svc().patchBook(owner, libA, { subKey: 't52-book', level: 'F', grade: 'G9' });
    const issue = await svc().createIssue(owner, { studentId: studentA, libId: libA, state: 'ok', progressPage: 55 });
    const cleared = { subKey: null, level: null, grade: null, pages: null };

    await svc().patchBook(owner, libA, plainToInstance(BookPatchDto, cleared));

    expect((await svc().all()).items.find((book) => book.id === libA)).toMatchObject(cleared);
    expect((await q.query(`SELECT sub_key,level,grade,pages FROM lib WHERE id=$1`, [libA]))[0])
      .toEqual({ sub_key: null, level: null, grade: null, pages: null });
    const tracked = (await svc().tracking()).students.find((student) => student.id === studentA)?.issues.find((row) => row.id === issue.id);
    expect(tracked).toMatchObject({ progressPage: 55, progressPercent: null });
    const [log] = await q.query(`SELECT actor_id,before,after FROM log WHERE entity='LIB' AND entity_id=$1 AND action='edit' ORDER BY id DESC LIMIT 1`, [libA]);
    expect(log).toMatchObject({
      actor_id: String(owner), before: { subKey: 't52-book', level: 'F', grade: 'G9', pages: 100 }, after: cleared,
    });

    // 전체 쪽수 미정은 0쪽이 아니다. 다시 숫자를 적으면 기존 진도 하한 검사가 그대로 적용된다.
    await expect(svc().patchBook(owner, libA, { pages: 50 }))
      .rejects.toMatchObject({ response: { code: 'BOOK_PAGES_BELOW_PROGRESS' } });
    await svc().patchBook(owner, libA, { pages: 60 });
    expect((await svc().all()).items.find((book) => book.id === libA)?.pages).toBe(60);
  });

  it('수정 요청에서 생략한 선택 정보는 저장된 값을 보존한다', async () => {
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('t52-book','교재 검수','#123456') ON CONFLICT (key) DO NOTHING`);
    await svc().patchBook(owner, libA, { subKey: 't52-book', level: 'F', grade: 'G9' });
    await svc().patchBook(owner, libA, { title: '제목만 수정' });
    expect((await svc().all()).items.find((book) => book.id === libA))
      .toMatchObject({ title: '제목만 수정', subKey: 't52-book', level: 'F', grade: 'G9', pages: 100 });
    const [log] = await q.query(`SELECT before,after FROM log WHERE entity='LIB' AND entity_id=$1 AND action='edit' ORDER BY id DESC LIMIT 1`, [libA]);
    expect(log).toEqual({ before: { title: '교재 A' }, after: { title: '제목만 수정' } });
  });

  it('배부→진도→회수가 ISSUE 한 행과 HIST에 원자적으로 이어진다', async () => {
    const issue = await svc().createIssue(owner, { studentId: studentA, libId: libA, state: 'ok' });
    await expect(svc().createIssue(owner, { studentId: studentA, libId: libA, state: 'ok' }))
      .rejects.toMatchObject({ response: { code: 'BOOK_ALREADY_ACTIVE' } });
    expect(await svc().updateIssueProgress(owner, issue.id, 55)).toMatchObject({ progressPage: 55, progressPercent: 55 });
    await expect(svc().updateIssueProgress(owner, issue.id, 101)).rejects.toThrow(/100쪽/);
    const tracking = await svc().tracking();
    expect(tracking.students.find((student) => student.id === studentA)?.todos)
      .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'guide_missing', label: '안내 없음' })]));
    expect(tracking.books.find((book) => book.libId === libA)).toMatchObject({
      pages: 100,
      students: [expect.objectContaining({ studentId: studentA, percent: 55 })],
    });
    expect(await svc().returnIssue(owner, issue.id)).toMatchObject({ state: 'returned' });
    expect((await svc().all()).items.find((book) => book.id === libA)?.issueCount).toBe(1);
    const rows = await q.query(`SELECT action FROM hist WHERE entity='issue' AND ref_id=$1 ORDER BY id`, [issue.id]);
    expect(rows.map((row: { action: string }) => row.action)).toEqual(['book_issue', 'book_drop']);
  });

  it('배부 생성은 그 날짜의 현재 판·파일을 ISSUE에 고정하고 이후 판 전환에도 소급 변경하지 않는다', async () => {
    const v1 = await svc().addVersion(owner, libA, {
      edition: 'v1',
      seFile: { kind: 'lib-se', name: 'v1-se.pdf', base64: Buffer.from('v1-se').toString('base64') },
      teFile: { kind: 'lib-te', name: 'v1-te.pdf', base64: Buffer.from('v1-te').toString('base64') },
    });
    const issue = await svc().createIssue(owner, { studentId: studentA, libId: libA, state: 'wait' });
    expect(issue).toMatchObject({
      state: 'wait', versId: v1.id, edition: 'v1', seFileId: v1.seFileId, teFileId: v1.teFileId,
    });
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM hist WHERE entity='issue' AND ref_id=$1`, [issue.id]))[0].n)).toBe(0);
    await expect(svc().transitionIssue(owner, issue.id, 'ok'))
      .rejects.toMatchObject({ response: { code: 'ISSUE_INVALID_TRANSITION' } });
    expect(await svc().transitionIssue(owner, issue.id, 'auto')).toMatchObject({ state: 'auto' });
    await expect(svc().updateIssueProgress(owner, issue.id, 1))
      .rejects.toMatchObject({ response: { code: 'BOOK_NOT_DELIVERED' } });

    await svc().addVersion(owner, libA, {
      edition: 'v2',
      seFile: { kind: 'lib-se', name: 'v2-se.pdf', base64: Buffer.from('v2-se').toString('base64') },
    });
    expect(await svc().transitionIssue(owner, issue.id, 'ok')).toMatchObject({ state: 'ok', versId: v1.id });
    await expect(svc().transitionIssue(owner, issue.id, 'auto'))
      .rejects.toMatchObject({ response: { code: 'ISSUE_INVALID_TRANSITION' } });
    const tracked = (await svc().tracking()).students
      .find((student) => student.id === studentA)?.issues.find((row) => row.id === issue.id);
    expect(tracked).toMatchObject({
      versId: v1.id, edition: 'v1', seFileId: v1.seFileId, teFileId: v1.teFileId,
    });
    expect((await q.query(`SELECT vers_id FROM issue WHERE id=$1`, [issue.id]))[0])
      .toEqual({ vers_id: String(v1.id) });
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM hist WHERE entity='issue' AND ref_id=$1 AND action='book_issue'`, [issue.id]))[0].n)).toBe(1);
  });

  it('다학생·다교재 요청은 지정 코디네이터만 pending→delivered→received로 끝낸다', async () => {
    const v1 = await svc().addVersion(owner, libA, {
      edition: 'v1',
      seFile: { kind: 'lib-se', name: 'v1.pdf', base64: Buffer.from('1').toString('base64') },
      teFile: { kind: 'lib-te', name: 'v1-te.pdf', base64: Buffer.from('1-te').toString('base64') },
    });
    await svc().addVersion(owner, libB, {
      edition: 'v1',
      seFile: { kind: 'lib-se', name: 'b-v1.pdf', base64: Buffer.from('b-1').toString('base64') },
      teFile: { kind: 'lib-te', name: 'b-v1-te.pdf', base64: Buffer.from('b-1-te').toString('base64') },
    });
    const made = await svc().createPack(owner, {
      packType: 'exam', title: '중간고사 자료', coordinatorId: coordinator,
      studentIds: [studentA, studentB], libIds: [libA, libB], effectiveOn: EFFECTIVE_ON,
    });
    expect(made.effectiveOn).toBe(EFFECTIVE_ON);
    expect(made.students).toHaveLength(2); expect(made.books).toHaveLength(2);
    expect(made.books.find((book) => book.id === libA)).toMatchObject({ versId: v1.id, seFileId: v1.seFileId });
    await svc().addVersion(owner, libA, {
      edition: 'v2', seFile: { kind: 'lib-se', name: 'v2.pdf', base64: Buffer.from('2').toString('base64') },
    });
    expect((await svc().packs(coordinator)).items.find((pack) => pack.id === made.id)?.books.find((book) => book.id === libA))
      .toMatchObject({ versId: v1.id, seFileId: v1.seFileId });
    await expect(svc().transitionPack(owner, made.id, 'received'))
      .rejects.toMatchObject({ response: { code: 'PACK_INVALID_TRANSITION' } });
    expect(await svc().transitionPack(owner, made.id, 'delivered')).toMatchObject({ state: 'delivered', canReceive: false });
    expect((await svc().packs(coordinator)).items.find((pack) => pack.id === made.id)).toMatchObject({ canReceive: true });
    expect((await svc().packs(owner)).items.find((pack) => pack.id === made.id)).toMatchObject({ canReceive: false });
    expect(await svc().patchPack(owner, made.id, { title: '중간고사 자료 수정' })).toMatchObject({ state: 'pending', title: '중간고사 자료 수정', deliveredAt: null, canReceive: false });
    expect(await svc().transitionPack(owner, made.id, 'delivered')).toMatchObject({ state: 'delivered', canReceive: false });
    await expect(svc().transitionPack(owner, made.id, 'received'))
      .rejects.toMatchObject({ response: { code: 'PACK_RECEIVER_ONLY' } });
    expect(await svc().transitionPack(coordinator, made.id, 'received')).toMatchObject({ state: 'received', canReceive: false });
    const [stored] = await q.query(`SELECT state,delivered_at,received_at FROM gpapack WHERE id=$1`, [made.id]);
    expect(stored.state).toBe('received'); expect(stored.delivered_at).toBeTruthy(); expect(stored.received_at).toBeTruthy();
    const notices = await q.query(`SELECT to_id,from_id,body,link,category FROM noti WHERE to_id=$1 AND link='/books?tab=requests'`, [owner]);
    expect(notices).toEqual([expect.objectContaining({ to_id: String(owner), from_id: String(coordinator), category: 'request' })]);
    expect(String(notices[0].body)).toContain('중간고사 자료 수정');
    const recipients = (await q.query(
      `SELECT to_id FROM noti WHERE from_id=$1 AND link='/books?tab=requests' ORDER BY to_id`, [coordinator],
    )).map((row: { to_id: string }) => Number(row.to_id));
    expect(recipients).toEqual(expect.arrayContaining([owner, managerRecipient]));
    expect(recipients).not.toContain(teacherOverride);
    expect(recipients).not.toContain(deniedCoordinator);
  });

  it('적용일 판이나 SE/TE가 빠진 묶음은 저장해도 전달할 수 없다', async () => {
    await svc().addVersion(owner, libA, {
      edition: 'se-only', seFile: { kind: 'lib-se', name: 'se.pdf', base64: Buffer.from('se').toString('base64') },
    });
    const made = await svc().createPack(owner, {
      packType: 'self', title: '미완성 묶음', effectiveOn: EFFECTIVE_ON, coordinatorId: coordinator,
      studentIds: [studentA], libIds: [libA],
    });
    expect(made.canDeliver).toBe(false);
    expect(made.deliveryBlockers).toContain('교사용 TE 파일');
    await expect(svc().transitionPack(owner, made.id, 'delivered'))
      .rejects.toMatchObject({ response: { code: 'PACK_NOT_READY' } });
    expect((await q.query(`SELECT state FROM gpapack WHERE id=$1`, [made.id]))[0].state).toBe('pending');
  });

  it('매니저 역할이어도 개인 canGpaPack=false이면 코디네이터가 될 수 없다', async () => {
    await expect(svc().createPack(owner, {
      packType: 'self', title: '권한 방어 묶음', effectiveOn: EFFECTIVE_ON,
      coordinatorId: deniedCoordinator, studentIds: [studentA], libIds: [libA],
    })).rejects.toThrow('자료를 받을 권한이 있는 활성 코디네이터');
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM gpapack WHERE title='권한 방어 묶음'`))[0].n)).toBe(0);
  });

  it('ISSUE와 GPAPACK_LIB는 다른 교재의 판을 연결할 수 없다', async () => {
    const a = await svc().addVersion(owner, libA, { edition: 'a-v1' });
    const b = await svc().addVersion(owner, libB, { edition: 'b-v1' });
    await q.query('SAVEPOINT issue_fk');
    await expect(q.query(
      `INSERT INTO issue (lib_id,vers_id,student_id,issued_on,state,delivered_at)
       VALUES ($1,$2,$3,current_date,'ok',now())`, [libA, b.id, studentA],
    )).rejects.toMatchObject({ constraint: 'issue_vers_lib_fk' });
    await q.query('ROLLBACK TO SAVEPOINT issue_fk');

    const pack = await svc().createPack(owner, {
      packType: 'self', title: '복합키 검사', effectiveOn: EFFECTIVE_ON, coordinatorId: coordinator,
      studentIds: [studentA], libIds: [libA],
    });
    expect(a.libId).toBe(libA);
    await q.query('SAVEPOINT pack_fk');
    await expect(q.query(
      `UPDATE gpapack_lib SET vers_id=$2 WHERE gpapack_id=$1 AND lib_id=$3`, [pack.id, b.id, libA],
    )).rejects.toMatchObject({ constraint: 'gpapack_lib_vers_fk' });
    await q.query('ROLLBACK TO SAVEPOINT pack_fk');
  });

  it('레거시 필수값 누락 묶음 PATCH는 안정적인 오류를 내고 한 칸도 쓰지 않는다', async () => {
    await q.query(`ALTER TABLE gpapack DROP CONSTRAINT gpapack_required_for_write`);
    const [legacy] = await q.query(
      `INSERT INTO gpapack (pack_type,title,state,created_by) VALUES ('self','레거시 원본','pending',$1) RETURNING id,updated_at`,
      [owner],
    );
    await q.query(`ALTER TABLE gpapack ADD CONSTRAINT gpapack_required_for_write
      CHECK (effective_on IS NOT NULL AND coordinator_id IS NOT NULL) NOT VALID`);
    await expect(svc().patchPack(owner, Number(legacy.id), { title: '쓰이면 안 됨' }))
      .rejects.toMatchObject({ response: { code: 'PACK_INCOMPLETE' } });
    const [after] = await q.query(`SELECT title,state,effective_on,coordinator_id,updated_at FROM gpapack WHERE id=$1`, [legacy.id]);
    expect(after).toMatchObject({ title: '레거시 원본', state: 'pending', effective_on: null, coordinator_id: null, updated_at: legacy.updated_at });
  });

  it.each([0, 2])('down은 학생 %i명 묶음을 만나면 손실 롤백을 시작하지 않는다', async (studentCount) => {
    const [pack] = await q.query(
      `INSERT INTO gpapack (pack_type,title,state,effective_on,coordinator_id,created_by)
       VALUES ('self','down 방어','pending',current_date,$1,$2) RETURNING id`, [coordinator, owner],
    );
    if (studentCount === 2) {
      await q.query(`INSERT INTO gpapack_student VALUES ($1,$2),($1,$3)`, [pack.id, studentA, studentB]);
    }
    await q.query('SAVEPOINT down_guard');
    await expect(new BookWorkflow1759700000000().down(q)).rejects.toThrow(/exactly one student/);
    await q.query('ROLLBACK TO SAVEPOINT down_guard');
    expect((await q.query(`SELECT title FROM gpapack WHERE id=$1`, [pack.id]))[0].title).toBe('down 방어');
    expect((await q.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='gpapack' AND column_name='student_id'`,
    ))[0].n).toBe(0);
  });

  it('교재 코드·자료 학생/교재 목록은 trim과 중복 계약을 서비스·DB까지 보존한다', async () => {
    const made = await svc().createBook(owner, { code: '  C77-TRIM  ', title: '  공백 정리 교재  ' });
    expect(made).toMatchObject({ code: 'C77-TRIM', title: '공백 정리 교재' });
    await expect(svc().createBook(owner, { code: 'C77-TRIM', title: '중복' }))
      .rejects.toMatchObject({ response: { code: 'BOOK_CODE_DUPLICATE' } });
    await expect(svc().createPack(owner, {
      packType: 'self', title: '중복 학생', effectiveOn: EFFECTIVE_ON, coordinatorId: coordinator,
      studentIds: [studentA, studentA], libIds: [libA],
    })).rejects.toThrow('학생을 중복 선택');
    await expect(svc().createPack(owner, {
      packType: 'self', title: '중복 교재', effectiveOn: EFFECTIVE_ON, coordinatorId: coordinator,
      studentIds: [studentA], libIds: [libA, libA],
    })).rejects.toThrow('교재를 중복 선택');
  });

  it('book_change는 student_id를 우선하고, 이름이 중복인 레거시는 어느 학생에도 오귀속하지 않는다', async () => {
    await q.query(`UPDATE stu SET name='동명이인' WHERE id=$1`, [studentA]);
    await q.query(`UPDATE stu SET name='동명이인' WHERE id=$1`, [studentB]);
    await q.query(
      `INSERT INTO req (staff_id,req_type,payload,state) VALUES ($1,'book_change',$2::jsonb,'pending')`,
      [teacherOverride, JSON.stringify({ studentName: '동명이인', message: '레거시' })],
    );
    await q.query(
      `INSERT INTO req (staff_id,req_type,student_id,payload,state) VALUES ($1,'book_change',$2,$3::jsonb,'pending')`,
      [teacherOverride, studentA, JSON.stringify({ studentName: '예전 이름', message: '연결됨' })],
    );
    const tracking = await svc().tracking();
    expect(tracking.teacherRequests.find((request) => request.message === '레거시')).toMatchObject({ studentId: null, studentName: '동명이인' });
    expect(tracking.teacherRequests.find((request) => request.message === '연결됨')).toMatchObject({ studentId: studentA, studentName: '동명이인' });
    expect(tracking.students.find((student) => student.id === studentA)?.todos)
      .toContainEqual(expect.objectContaining({ key: 'teacher_request', count: 1 }));
    expect(tracking.students.find((student) => student.id === studentB)?.todos)
      .not.toContainEqual(expect.objectContaining({ key: 'teacher_request' }));
  });
});
