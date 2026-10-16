/** @file-guide
 * 목적: files-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 파일 저장소 — **Neon 안에 둔다** (대표 결정 2026-09-12: 「파일 저장소는 Neon에 올릴 수 있으면 올리기」).
 *
 * 여기서 증명하는 것은 넷이다.
 *   ① 본문이 표에 그대로 들어가고 그대로 나온다 (sha256 이 같다)
 *   ② 길이는 **우리가 다시 센다** — 화면이 보낸 숫자를 믿지 않는다
 *   ③ 한도를 넘으면 조용히 자르지 않고 **거절한다** (그리고 표도 거절한다)
 *   ④ 가리키는 주소는 `/files/{id}` — 저장소가 어디인지 주소 모양으로 갈린다
 */
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { FileRow, Ser } from '../src/entities';
import { addDays, todayKst } from '../src/lib/kst';
import { FILE_KINDS, FILE_MAX_BYTES } from '../src/modules/files/files.dto';
import { canReadStoredFile, decodeBase64, FilesService, fileUrlOf, mimeOf } from '../src/modules/files/files.service';
import { TeacherService } from '../src/modules/teacher/teacher.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions, url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

describe('파일 이름에서 MIME — 모르는 확장자는 지어내지 않는다', () => {
  it.each([
    ['계약서.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['영수증.PNG', 'image/png'],
    ['교재.pdf', 'application/pdf'],
    ['무엇.xyz', 'application/octet-stream'],
    ['확장자없음', 'application/octet-stream'],
  ])('%s → %s', (name, mime) => expect(mimeOf(name)).toBe(mime));
});

describe('base64 해독 — data URL 이 붙어 있어도 벗긴다', () => {
  it('접두사가 있든 없든 같은 바이트가 나온다', () => {
    const raw = Buffer.from('타코').toString('base64');
    expect(decodeBase64(raw)?.toString()).toBe('타코');
    expect(decodeBase64(`data:image/png;base64,${raw}`)?.toString()).toBe('타코');
    expect(decodeBase64('  ' + raw + '\n')?.toString()).toBe('타코');
  });
  it('빈 본문과 base64 가 아닌 글자는 null 이다 — 0바이트 행을 만들지 않는다', () => {
    expect(decodeBase64('')).toBeNull();
    expect(decodeBase64('!!!!')).toBeNull();
  });
});

describe('FILE kind별 중앙 권한표', () => {
  const facts = {
    uploadedBy: 10, bookLinked: false, expenseLinked: false, expenseRequester: false,
    reportLinked: false, reportTeacher: false,
    consultingLinked: false, consultingActive: false, consultingFullAccess: false,
  };
  const teacher = { id: 10, name: '강사', role: 'teacher' };
  const manager = { id: 20, name: '매니저', role: 'manager' };
  const ceo = { id: 30, name: '대표', role: 'ceo' };
  /**
   * **금액·비공개를 사람별 예외로 끈 매니저.**
   *
   * 이 표가 묻는 것은 「`canMoney`/`canHide` 를 보는가」이지 「누가 대표인가」가 아니다.
   * 대표 결정 2026-09-21 로 역할 파생이 관리자급까지 열려, 역할만으로는 그 경계를 세울 수 없다 —
   * 바로 위 `canGpaPack` 줄이 이미 쓰던 방식(예외 칸을 끈다)을 그대로 쓴다.
   */
  const noMoney = { ...manager, perms: { canMoney: false } };
  const noHide = { ...manager, perms: { canHide: false } };

  it('인수인계와 관리자 전용 특이사항은 FILE kind를 만들지 않는다', () => {
    expect(FILE_KINDS).not.toEqual(expect.arrayContaining(['note', 'handover-note', 'private-note']));
  });

  it('교재 파일은 실제 판 연결과 관리자 화면·자료 권한을 모두 요구한다', () => {
    expect(canReadStoredFile(manager, 'lib-te', facts)).toBe(false);
    expect(canReadStoredFile(manager, 'lib-te', { ...facts, bookLinked: true })).toBe(true);
    expect(canReadStoredFile({ ...manager, perms: { canGpaPack: false } }, 'lib-te', { ...facts, bookLinked: true })).toBe(false);
    expect(canReadStoredFile({ ...teacher, perms: { canGpaPack: true } }, 'lib-te', { ...facts, bookLinked: true })).toBe(false);
    expect(canReadStoredFile(teacher, 'lib-se', { ...facts, bookLinked: true, bookAssignedTeacher: true })).toBe(true);
    expect(canReadStoredFile(teacher, 'lib-te', { ...facts, bookLinked: true, bookAssignedTeacher: true })).toBe(true);
    expect(canReadStoredFile(teacher, 'lib-te', { ...facts, bookAssignedTeacher: true })).toBe(false);
  });

  it('영수증은 연결 원장의 요청자 또는 canMoney만, 컨설팅은 업로더 또는 canHide만 연다', () => {
    expect(canReadStoredFile(teacher, 'expense-receipt', { ...facts, expenseLinked: true, expenseRequester: true })).toBe(true);
    expect(canReadStoredFile(noMoney, 'expense-receipt', { ...facts, expenseLinked: true })).toBe(false);
    expect(canReadStoredFile(teacher, 'expense-receipt', { ...facts, expenseLinked: true })).toBe(false);
    // 역할 파생이 열린 뒤에는 매니저도 연다 — 판정은 여전히 canMoney 한 곳이다
    expect(canReadStoredFile(manager, 'expense-receipt', { ...facts, expenseLinked: true })).toBe(true);
    expect(canReadStoredFile(ceo, 'expense-receipt', { ...facts, expenseLinked: true })).toBe(true);
    expect(canReadStoredFile(noHide, 'cons-contract', facts)).toBe(false);
    expect(canReadStoredFile(teacher, 'cons-contract', facts)).toBe(false);
    expect(canReadStoredFile({ ...noHide, id: 10 }, 'cons-contract', facts)).toBe(true);
    expect(canReadStoredFile(ceo, 'cons-contract', facts)).toBe(true);
  });

  it('연결된 계약 파일은 업로더가 아니라 활성 건의 csCanFull을 따른다', () => {
    const linked = { ...facts, consultingLinked: true, consultingActive: true, consultingFullAccess: true };
    expect(canReadStoredFile(manager, 'cons-contract', linked)).toBe(true);
    expect(canReadStoredFile(teacher, 'cons-contract', linked)).toBe(false);
    expect(canReadStoredFile(noHide, 'cons-contract', { ...linked, consultingFullAccess: false })).toBe(false);
    expect(canReadStoredFile(teacher, 'cons-contract', { ...linked, consultingFullAccess: false })).toBe(false);
    expect(canReadStoredFile(ceo, 'cons-contract', { ...linked, consultingFullAccess: false })).toBe(true);
    expect(canReadStoredFile(ceo, 'cons-contract', { ...linked, consultingActive: false })).toBe(false);
  });

  it('리포트는 담당 강사 또는 관리자만 열고, 알 수 없는 kind는 기본 거절한다', () => {
    expect(canReadStoredFile(teacher, 'report-png', { ...facts, uploadedBy: null, reportLinked: true, reportTeacher: true })).toBe(true);
    expect(canReadStoredFile(manager, 'report-png', { ...facts, uploadedBy: null, reportLinked: true })).toBe(true);
    expect(canReadStoredFile(teacher, 'report-png', { ...facts, uploadedBy: null, reportLinked: true })).toBe(false);
    expect(canReadStoredFile(manager, 'future-kind' as never, facts)).toBe(false);
  });

  it('일반 자료요청 파일은 실제 MATREQ 링크와 요청 강사 또는 관리자 자료 권한을 모두 요구한다', () => {
    const linked = { ...facts, materialRequestLinked: true, materialRequestTeacher: true };
    expect(canReadStoredFile(teacher, 'material-request', linked)).toBe(true);
    expect(canReadStoredFile({ ...teacher, id: 11 }, 'material-request', { ...linked, materialRequestTeacher: false })).toBe(false);
    expect(canReadStoredFile(manager, 'material-request', { ...linked, materialRequestTeacher: false })).toBe(true);
    expect(canReadStoredFile({ ...manager, perms: { canGpaPack: false } }, 'material-request', {
      ...linked, materialRequestTeacher: false,
    })).toBe(false);
    expect(canReadStoredFile(manager, 'material-request', facts)).toBe(false);
  });
});

d('FILE — 올린 파일이 Neon 안에 그대로 있다 (C48)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const ME = 71;
  const svc = () => new FilesService(q.manager.getRepository(FileRow));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES ($1,'파일 올린 사람','file71@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`, [ME],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('올린 본문이 바이트 하나 안 틀리고 돌아온다', async () => {
    const bytes = Buffer.from('민제인 에세이 컨설팅 계약서 초안');
    const ref = await svc().upload(ME, { kind: 'cons-contract', name: '계약서.docx', base64: bytes.toString('base64') });
    expect(ref).toMatchObject({ kind: 'cons-contract', name: '계약서.docx', bytes: bytes.length });
    expect(ref.url).toBe(fileUrlOf(ref.id));

    const back = await svc().read(ref.id);
    expect(back.data?.equals(bytes)).toBe(true);
    const [row] = (await q.query(`SELECT sha256, bytes FROM file WHERE id = $1`, [ref.id])) as { sha256: string; bytes: number }[];
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(row.bytes).toBe(bytes.length);
  });

  it('클라이언트 MIME은 저장 계약이 아니며 서버가 파일 이름으로 다시 정한다', async () => {
    const ref = await svc().upload(ME, {
      kind: 'lib-se', name: '교재.pdf', base64: Buffer.from('pdf').toString('base64'), mime: 'text/html',
    } as never);
    expect(ref.mime).toBe('application/pdf');
    const [row] = await q.query(`SELECT mime FROM file WHERE id=$1`, [ref.id]);
    expect(row.mime).toBe('application/pdf');
  });

  it('raw 교재 파일은 업로더여도 판에 연결되기 전에는 닫고, 연결 뒤 두 권한을 확인한다', async () => {
    const ref = await svc().upload(ME, { kind: 'lib-te', name: '교사용.pdf', base64: Buffer.from('te').toString('base64') });
    await expect(svc().readAuthorized({ id: ME, name: '매니저', role: 'manager' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    const [lib] = await q.query(`INSERT INTO lib (code,title) VALUES ($1,'raw 파일 교재') RETURNING id`, [`FILE-${ref.id}`]);
    await q.query(`INSERT INTO vers (lib_id,edition,te_file_id) VALUES ($1,'v1',$2)`, [lib.id, ref.id]);
    await expect(svc().readAuthorized({ id: 72, name: '강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await expect(svc().readAuthorized({ id: ME, name: '매니저', role: 'manager', perms: { canGpaPack: false } }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await expect(svc().readAuthorized({ id: ME, name: '매니저', role: 'manager' }, ref.id))
      .resolves.toMatchObject({ kind: 'lib-te' });
  });

  it('강사는 현재 또는 장래 담당 수업의 배부 완료된 판만 읽고 담당·수강 종료나 반환 즉시 권한을 잃는다', async () => {
    await q.query(`INSERT INTO staff(id,name,email,role) VALUES (72,'담당 강사','file72@t.kr','teacher') ON CONFLICT(id) DO NOTHING`);
    await q.query(`INSERT INTO staff(id,name,email,role) VALUES (73,'다른 강사','file73@t.kr','teacher') ON CONFLICT(id) DO NOTHING`);
    await q.query(`INSERT INTO kind(key,name,color,cap,grp) VALUES ('file-kind','파일 시험','#A85764',1,'lesson') ON CONFLICT(key) DO NOTHING`);
    await q.query(`INSERT INTO sub(key,name,color,kind_key) VALUES ('file-test','파일 테스트','#A85764','file-kind') ON CONFLICT(key) DO NOTHING`);
    await q.query(`INSERT INTO stu(id,name,grade) VALUES (71,'합성 학생','G9') ON CONFLICT(id) DO NOTHING`);
    await q.query(`INSERT INTO ser(id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date)
      VALUES (-72001,'file-kind','file-test',72,'offline',900,960,'FREQ=WEEKLY',current_date)`);
    await q.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES (-72001,71)`);
    const ref = await svc().upload(ME, { kind: 'lib-se', name: '학생용.pdf', base64: Buffer.from('pdf').toString('base64') });
    const [lib] = await q.query(`INSERT INTO lib(code,title,sub_key,grade_from,grade_to)
      VALUES ($1,'배정 교재','file-test',9,9) RETURNING id`, [`ASSIGNED-${ref.id}`]);
    const [vers] = await q.query(`INSERT INTO vers(lib_id,edition,se_file_id) VALUES ($1,'v1',$2) RETURNING id`, [lib.id, ref.id]);
    const [issue] = await q.query(
      `INSERT INTO issue(lib_id,vers_id,student_id,teacher_id,sub_key,issued_on,state)
       VALUES ($1,$2,71,72,'file-test',current_date,'ok') RETURNING id`, [lib.id, vers.id],
    );
    await expect(svc().readAuthorized({ id: 72, name: '담당 강사', role: 'teacher' }, ref.id)).resolves.toMatchObject({ name: '학생용.pdf' });
    await expect(svc().readAuthorized({ id: 73, name: '다른 강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });

    // ISSUE의 담당자 스냅샷이 남아 있어도 실제 수업이 재배정되면 옛 담당자는 내려받을 수 없다.
    await q.query(`UPDATE ser SET teacher_id=73 WHERE id=-72001`);
    await expect(svc().readAuthorized({ id: 72, name: '옛 담당 강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await q.query(`UPDATE ser SET teacher_id=72,from_date=current_date-1,to_date=current_date-1 WHERE id=-72001`);
    await expect(svc().readAuthorized({ id: 72, name: '수업 종료 강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });

    // 수업이 계속돼도 해당 학생의 수강 기간이 끝나면 같은 파일 ID의 접근을 다시 닫는다.
    await q.query(`UPDATE ser SET to_date=NULL WHERE id=-72001`);
    await q.query(`UPDATE ser_stu SET to_date=current_date-1 WHERE ser_id=-72001 AND student_id=71`);
    await expect(svc().readAuthorized({ id: 72, name: '수강 종료 학생 강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });

    // 배정 옵션과 같이 장래 수업은 허용한다. 아직 materialize하지 않은 SER_OCC는 권한 근거가 아니다.
    await q.query(`UPDATE ser SET from_date=current_date+1 WHERE id=-72001`);
    await q.query(`UPDATE ser_stu SET from_date=current_date+1,to_date=NULL WHERE ser_id=-72001 AND student_id=71`);
    await expect(svc().readAuthorized({ id: 72, name: '장래 담당 강사', role: 'teacher' }, ref.id))
      .resolves.toMatchObject({ name: '학생용.pdf' });
    await q.query(`UPDATE issue SET state='returned',returned_on=current_date,row_version=row_version+1 WHERE id=$1`, [issue.id]);
    await expect(svc().readAuthorized({ id: 72, name: '담당 강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
  });

  it.each([
    ['현재 담당 수업', 'current', true, 72],
    ['회차 생성 전 장래 담당 수업', 'future', true, 72],
    ['끝난 담당 수업', 'class-ended', false, 72],
    ['끝난 학생 수강 기간', 'roster-ended', false, 72],
    ['담당자가 교체된 수업', 'reassigned', false, 72],
    ['같은 학생을 가르치는 다른 담당자', 'other', false, 73],
  ] as const)('과거 주 안내를 열어도 %s의 SE/TE 표시와 raw 파일 권한이 일치한다', async (
    _label, scenario, allowed, viewerId,
  ) => {
    const today = todayKst();
    const historicalDay = addDays(today, -14);
    const futureDay = addDays(today, 14);
    await q.query(`INSERT INTO staff(id,name,email,role) VALUES
      (72,'담당 강사','file72@t.kr','teacher'),(73,'다른 강사','file73@t.kr','teacher') ON CONFLICT(id) DO NOTHING`);
    await q.query(`INSERT INTO kind(key,name,color,cap,grp) VALUES
      ('file-mask-kind','파일 표시 시험','#A85764',1,'lesson') ON CONFLICT(key) DO NOTHING`);
    await q.query(`INSERT INTO sub(key,name,color,kind_key) VALUES
      ('file-mask-sub','파일 표시 과목','#A85764','file-mask-kind') ON CONFLICT(key) DO NOTHING`);
    await q.query(`INSERT INTO stu(id,name,grade) VALUES (71,'파일 표시 합성 학생','G9') ON CONFLICT(id) DO NOTHING`);
    for (const [serId, teacherId, start] of [[-72101, 72, '15:00'], [-72102, 73, '17:00']] as const) {
      await q.query(`INSERT INTO ser(id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date)
        VALUES ($1,'file-mask-kind','file-mask-sub',$2,'offline',900,960,'FREQ=WEEKLY',$3::date)`,
      [serId, teacherId, historicalDay]);
      await q.query(`INSERT INTO ser_stu(ser_id,student_id,from_date) VALUES ($1,71,$2::date)`, [serId, historicalDay]);
      await q.query(`INSERT INTO ser_occ(ser_id,on_date,teacher_id,canceled,span)
        VALUES ($1,$2::date,$3,false,tstzrange(($2::date+$4::time) AT TIME ZONE 'Asia/Seoul',
          (($2::date+$4::time)+interval '1 hour') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [serId, historicalDay, teacherId, start]);
    }
    const se = await svc().upload(ME, {
      kind: 'lib-se', name: '표시-SE.pdf', base64: Buffer.from('se').toString('base64'),
    });
    const te = await svc().upload(ME, {
      kind: 'lib-te', name: '표시-TE.pdf', base64: Buffer.from('te').toString('base64'),
    });
    const [lib] = await q.query(`INSERT INTO lib(code,title,sub_key,grade_from,grade_to)
      VALUES ($1,'파일 표시 교재','file-mask-sub',9,9) RETURNING id`, [`MASK-${se.id}`]);
    const [vers] = await q.query(`INSERT INTO vers(lib_id,edition,se_file_id,te_file_id)
      VALUES ($1,'v1',$2,$3) RETURNING id`, [lib.id, se.id, te.id]);
    const [issue] = await q.query(`INSERT INTO issue(lib_id,vers_id,student_id,teacher_id,sub_key,issued_on,state)
      VALUES ($1,$2,71,72,'file-mask-sub',$3::date,'ok') RETURNING id`, [lib.id, vers.id, today]);

    if (scenario === 'future') {
      await q.query(`UPDATE ser SET from_date=$1::date WHERE id=-72101`, [futureDay]);
    } else if (scenario === 'class-ended') {
      await q.query(`UPDATE ser SET to_date=$1::date WHERE id=-72101`, [addDays(today, -1)]);
    } else if (scenario === 'roster-ended') {
      await q.query(`UPDATE ser_stu SET to_date=$1::date WHERE ser_id=-72101 AND student_id=71`, [addDays(today, -1)]);
    } else if (scenario === 'reassigned') {
      await q.query(`UPDATE ser SET teacher_id=73 WHERE id=-72101`);
    }

    // 과거 학생·배정 내역은 남는다. 파일 ID만 오늘의 수업 문맥에 맞게 제거해야 한다.
    const guide = await new TeacherService(q.manager.getRepository(Ser)).guides(viewerId, historicalDay);
    const projected = guide.students.find((student) => student.studentId === 71)?.books
      .find((book) => book.issueId === Number(issue.id));
    expect(projected).toMatchObject({
      issueId: Number(issue.id), state: 'ok', seFileId: allowed ? se.id : null, teFileId: allowed ? te.id : null,
    });
    for (const ref of [se, te]) {
      const read = svc().readAuthorized({ id: viewerId, name: '파일 표시 시험 강사', role: 'teacher' }, ref.id);
      if (allowed) {
        await expect(read).resolves.toMatchObject({ name: ref.name });
      } else {
        await expect(read).rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
      }
    }
  });

  it.each(['private', 'money_only'])('담당·업로더가 바뀐 %s 컨설팅도 최초 등록자는 파일을 계속 읽는다', async (share) => {
    const OTHER = 75;
    await q.query(`INSERT INTO staff(id,name,email,role) VALUES ($1,'변경 담당자','file75@t.kr','manager')
      ON CONFLICT(id) DO NOTHING`, [OTHER]);
    const [template] = await q.query(`SELECT id FROM cons_template WHERE cons_type='admissions' AND active`);
    const [cons] = await q.query(`INSERT INTO cons(cons_type,stage,contract_step,share,owner_id,created_by,template_id)
      VALUES ('admissions','contract',1,$1,$2,$3,$4) RETURNING id`, [share, OTHER, ME, template.id]);
    await q.query(`INSERT INTO cons_write_req(request_key,action,cons_id,fingerprint,result_version,actor_id)
      VALUES ($1,'create',$2,repeat('a',64),1,$3)`, [randomUUID(), cons.id, ME]);
    const bytes = Buffer.from('최초 등록자가 확인할 합성 계약서');
    const ref = await svc().upload(OTHER, { kind: 'cons-contract', name: '계약서.pdf', base64: bytes.toString('base64') });
    await q.query(`INSERT INTO cons_file(file_id,cons_id,role,created_by) VALUES ($1,$2,'draft',$3)`, [ref.id, cons.id, OTHER]);
    const creator = { id: ME, name: '최초 등록자', role: 'manager', perms: { canHide: false } };

    await expect(svc().readAuthorized(creator, ref.id)).resolves.toMatchObject({ data: bytes });
    await expect(svc().readAuthorized({ ...creator, id: 76 }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await expect(svc().readAuthorized({ ...creator, perms: { canHide: false, canCrudAll: false } }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });

    await q.query(`UPDATE cons SET deleted_at=now(),deleted_by=$2 WHERE id=$1`, [cons.id, OTHER]);
    await expect(svc().readAuthorized(creator, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
  });

  it('한도를 넘으면 자르지 않고 거절한다 — 그리고 표도 거절한다', async () => {
    const big = Buffer.alloc(FILE_MAX_BYTES + 1, 7);
    await expect(svc().upload(ME, { kind: 'lib-se', name: '큰교재.pdf', base64: big.toString('base64') }))
      .rejects.toMatchObject({ response: { code: 'FILE_TOO_LARGE' } });

    // 서비스를 건너뛰어도 표가 막는다 (원칙 26 · 마지막 방어선)
    await q.query('SAVEPOINT cap');
    await expect(q.query(
      `INSERT INTO file (kind,name,mime,bytes,sha256,data) VALUES ('lib-se','x','application/pdf',$1,repeat('a',64),$2)`,
      [big.length, big],
    )).rejects.toMatchObject({ constraint: 'file_size_cap' });
    await q.query('ROLLBACK TO SAVEPOINT cap');
  });

  it('적어 보낸 길이와 실제 길이가 다르면 표가 거절한다 — 목록·용량이 거짓이 되지 않게', async () => {
    await expect(q.query(
      `INSERT INTO file (kind,name,mime,bytes,sha256,data)
       VALUES ('guide-png','x','image/png',999,repeat('a',64),$1)`,
      [Buffer.from('짧다')],
    )).rejects.toMatchObject({ constraint: 'file_bytes_match' });
  });

  it('빈 본문은 행을 만들지 않는다', async () => {
    await expect(svc().upload(ME, { kind: 'guide-png', name: 'x.png', base64: '' }))
      .rejects.toMatchObject({ response: { code: 'FILE_EMPTY' } });
    const [{ n }] = (await q.query(`SELECT count(*)::int AS n FROM file WHERE uploaded_by = $1`, [ME])) as { n: number }[];
    expect(n).toBe(0);
  });

  /*
   * 보안 검수 2026-09-25 (TBO-52 audit-0925 D1 🔴) — PDFLOG.ref_id 는 **발송(RSEND) id** 다
   * (reports.service deliver/resend). 예전 판정은 그 값을 리포트(REP) id 로 읽어서
   * 「발송 id 와 우연히 같은 번호의 리포트」 담당 강사가 남의 학생 PNG 를 열었고, 정작 쓴 강사는 막혔다.
   * 판정은 RSEND.rep_ids 에 든 리포트의 담당 강사로 한다.
   */
  it('리포트 PNG — 발송에 든 리포트의 담당 강사만 연다 (ref_id 는 RSEND id · 보안 0925)', async () => {
    const AUTHOR = 73, OTHER = 74, COLLIDE = 9_730_001;
    // 신규 격리 DB에서도 seed 학생 1번에 의존하지 않도록 이 트랜잭션의 합성 학생을 사용한다.
    const [student] = await q.query(`INSERT INTO stu(name,grade) VALUES ('파일 권한 합성 학생','G1') RETURNING id`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES ($1,'쓴 강사','file73@t.kr','teacher'), ($2,'남 강사','file74@t.kr','teacher')
       ON CONFLICT (id) DO NOTHING`, [AUTHOR, OTHER],
    );
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep,rep_form,sort)
       VALUES ('class','정규 수업','#4A5461',4,'lesson',true,'dev',1) ON CONFLICT (key) DO NOTHING`,
    );
    const ser = async (teacher: number) => Number((await q.query(
      `INSERT INTO ser (kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
       VALUES ('class',$1,'offline',540,600,'ONCE','2026-09-01','2026-09-01','파일 권한') RETURNING id`, [teacher],
    ))[0].id);
    const [authorRep] = await q.query(
      `INSERT INTO rep (ser_id,on_date,teacher_id,kind_key,body) VALUES ($1,'2026-09-01',$2,'class','{}') RETURNING id`,
      [await ser(AUTHOR), AUTHOR],
    );
    // 발송 id 와 **같은 번호**의 리포트를 남 강사가 갖고 있다 — 예전 판정이 이 줄로 열어 줬다
    await q.query(
      `INSERT INTO rep (id,ser_id,on_date,teacher_id,kind_key,body) VALUES ($1,$2,'2026-09-01',$3,'class','{}')`,
      [COLLIDE, await ser(OTHER), OTHER],
    );
    await q.query(
      `INSERT INTO rsend (id,student_id,on_date,rep_ids,channel,body,sent_by,request_key)
       VALUES ($1,$4,'2026-09-01',$2::jsonb,'blob','본문',$3,'00000000-0000-4000-8000-000000009731')`,
      [COLLIDE, JSON.stringify([Number(authorRep.id)]), ME, student.id],
    );
    const ref = await svc().upload(null, { kind: 'report-png', name: '20260901_학생.png', base64: Buffer.from('png').toString('base64') });
    await q.query(`INSERT INTO pdflog (kind,ref_id,file_url) VALUES ('report_png',$1,$2)`, [COLLIDE, ref.url]);

    await expect(svc().readAuthorized({ id: OTHER, name: '남 강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await expect(svc().readAuthorized({ id: AUTHOR, name: '쓴 강사', role: 'teacher' }, ref.id))
      .resolves.toMatchObject({ kind: 'report-png' });
    await expect(svc().readAuthorized({ id: ME, name: '매니저', role: 'manager' }, ref.id))
      .resolves.toMatchObject({ kind: 'report-png' });
  });

  it('지우면 본문도 같이 사라진다 — 가리키는 행과 같은 트랜잭션에서 지운다', async () => {
    const ref = await svc().upload(ME, { kind: 'expense-receipt', name: '영수증.png', base64: Buffer.from('img').toString('base64') });
    await svc().remove(ref.id);
    await expect(svc().read(ref.id)).rejects.toMatchObject({ response: { code: 'FILE_NOT_FOUND' } });
  });
});
