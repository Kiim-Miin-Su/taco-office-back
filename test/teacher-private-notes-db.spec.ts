/** @file-guide
 * 목적: BOC-09D-03 강사 작성·관리자 전용 학생 특이사항의 DB·service 회귀를 검증한다. (test)
 * 책임/재사용: 실제 PostgreSQL에서 회차/명단/actor/version/requestKey와 역할별 projection·직접쓰기 방어를 확인한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · migration 1767000000000
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { PrivateNotesService } from '../src/modules/private-notes/private-notes.service';
import { TeacherService } from '../src/modules/teacher/teacher.service';
import { Ser } from '../src/entities';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

type IdRow = { id: string };

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

d('BOC-09D-03 강사 특이사항 — teacher write / admin body projection', () => {
  let ds: DataSource;
  let service: PrivateNotesService;
  let teacherId = 0;
  let otherTeacherId = 0;
  let studentId = 0;
  let otherStudentId = 0;
  let serId = 0;
  const onDate = '2026-01-05';
  const kindKey = `pn${process.pid}`.slice(0, 16);
  const suffix = `${process.pid}-${Date.now()}`;

  const payload = (overrides: Partial<{
    studentId: number; serId: number; onDate: string; body: string; expectedVersion: number; requestKey: string;
  }> = {}) => ({
    studentId,
    serId,
    onDate,
    body: '수업 중 집중이 흔들려 다음 회차에서 확인이 필요합니다.',
    expectedVersion: 0,
    requestKey: randomUUID(),
    ...overrides,
  });

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    service = new PrivateNotesService(ds);
    const [teacher] = await ds.query(
      `INSERT INTO staff(name,email,role,tz) VALUES($1,$2,'teacher','Asia/Seoul') RETURNING id`,
      ['특이사항 강사', `private-note-${suffix}@qa.local`],
    ) as IdRow[];
    const [otherTeacher] = await ds.query(
      `INSERT INTO staff(name,email,role,tz) VALUES($1,$2,'teacher','Asia/Seoul') RETURNING id`,
      ['다른 강사', `private-note-other-${suffix}@qa.local`],
    ) as IdRow[];
    teacherId = Number(teacher.id);
    otherTeacherId = Number(otherTeacher.id);
    const [student] = await ds.query(`INSERT INTO stu(name,grade) VALUES('특이사항 학생','중2') RETURNING id`) as IdRow[];
    const [otherStudent] = await ds.query(`INSERT INTO stu(name,grade) VALUES('명단 밖 학생','중3') RETURNING id`) as IdRow[];
    studentId = Number(student.id);
    otherStudentId = Number(otherStudent.id);
    await ds.query(
      `INSERT INTO kind(key,name,color,cap,grp,rep) VALUES($1,'특이사항 QA','#123456',4,'lesson',true)`,
      [kindKey],
    );
    const [series] = await ds.query(
      `INSERT INTO ser(kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
       VALUES($1,$2,'offline',600,660,'ONCE',$3::date,$3::date,'특이사항 QA') RETURNING id`,
      [kindKey, teacherId, onDate],
    ) as IdRow[];
    serId = Number(series.id);
    await ds.query(`INSERT INTO ser_stu(ser_id,student_id,from_date) VALUES($1,$2,$3::date)`, [serId, studentId, onDate]);
    await ds.query(
      `INSERT INTO ser_occ(ser_id,on_date,teacher_id,canceled,span)
       VALUES($1,$2::date,$3,false,tstzrange('2026-01-05 10:00+09','2026-01-05 11:00+09','[)'))`,
      [serId, onDate, teacherId],
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM log WHERE entity='TPRIVNOTE' AND actor_id IN ($1,$2)`, [teacherId, otherTeacherId]);
    await ds.query(`DELETE FROM teacher_private_note WHERE ser_id=$1`, [serId]);
    await ds.query(`DELETE FROM ser_occ WHERE ser_id=$1`, [serId]);
    await ds.query(`DELETE FROM ser_stu WHERE ser_id=$1`, [serId]);
    await ds.query(`DELETE FROM ser WHERE id=$1`, [serId]);
    await ds.query(`DELETE FROM kind WHERE key=$1`, [kindKey]);
    await ds.query(`DELETE FROM stu WHERE id IN ($1,$2)`, [studentId, otherStudentId]);
    await ds.query(`DELETE FROM staff WHERE id IN ($1,$2)`, [teacherId, otherTeacherId]);
    await ds.destroy();
  });

  it('생성은 본문 없는 영수증만 반환하고 본문·version·요청 영수증·본문 없는 감사만 원자적으로 남긴다', async () => {
    const dto = payload();
    const receipt = await service.write(teacherId, dto);
    expect(receipt).toMatchObject({ studentId, serId, onDate, version: 1, studentName: '특이사항 학생' });
    expect(receipt).not.toHaveProperty('body');

    const [note] = await ds.query(`SELECT id,body,version FROM teacher_private_note WHERE id=$1`, [receipt.id]);
    expect(note).toMatchObject({ body: dto.body, version: 1 });
    const [request] = await ds.query(
      `SELECT actor_id,result_version,length(fingerprint) AS fingerprint_length
         FROM teacher_private_note_write_req WHERE request_key=$1`, [dto.requestKey],
    );
    expect(request).toMatchObject({ actor_id: String(teacherId), result_version: 1, fingerprint_length: 64 });
    const [log] = await ds.query(
      `SELECT before,after FROM log WHERE entity='TPRIVNOTE' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [receipt.id],
    );
    expect(JSON.stringify(log)).not.toContain(dto.body);
    expect(log.after).toMatchObject({ studentId, serId, onDate, version: 1 });
  });

  it('강사 히스토리는 정확한 회차 명단을 구조화 studentItems로 반환한다', async () => {
    const history = await new TeacherService(ds.getRepository(Ser)).history(teacherId, '2026-01');
    const lesson = history.lessons.find((item) => item.serId === serId && item.onDate === onDate);
    expect(lesson?.studentItems).toEqual([{ id: studentId, name: '특이사항 학생' }]);
  });

  it('동일 requestKey·payload는 같은 version으로 수렴하고 다른 payload 재사용은 409 계약으로 거절한다', async () => {
    const current = (await service.receipts(teacherId)).items[0];
    const dto = payload({ body: '멱등 저장 확인', expectedVersion: current.version });
    const first = await service.write(teacherId, dto);
    const replay = await service.write(teacherId, dto);
    expect(replay).toEqual(first);
    await expect(service.write(teacherId, { ...dto, body: '다른 내용' })).rejects.toMatchObject({
      response: { code: 'TEACHER_PRIVATE_NOTE_REQUEST_KEY_REUSED' },
    });
    const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM teacher_private_note_write_req WHERE request_key=$1`, [dto.requestKey]);
    expect(count).toBe(1);
  });

  it('최신 version만 수정하고 stale version과 이전 요청 replay는 현재 본문을 바꾸지 않는다', async () => {
    const current = (await service.receipts(teacherId)).items[0];
    const updated = await service.write(teacherId, payload({
      body: '관리자 확인이 필요한 수정 내용', expectedVersion: current.version,
    }));
    expect(updated.version).toBe(current.version + 1);
    await expect(service.write(teacherId, payload({ body: '오래된 수정', expectedVersion: current.version }))).rejects.toMatchObject({
      response: { code: 'TEACHER_PRIVATE_NOTE_VERSION_CONFLICT' },
    });
    const [row] = await ds.query(`SELECT body,version FROM teacher_private_note WHERE id=$1`, [updated.id]);
    expect(row).toMatchObject({ body: '관리자 확인이 필요한 수정 내용', version: updated.version });
  });

  it('다른 강사·명단 밖 학생·취소 회차는 같은 write 경로에서 차단한다', async () => {
    await expect(service.write(otherTeacherId, payload())).rejects.toMatchObject({
      response: { code: 'TEACHER_PRIVATE_NOTE_TARGET_NOT_FOUND' },
    });
    await expect(service.write(teacherId, payload({ studentId: otherStudentId }))).rejects.toMatchObject({
      response: { code: 'TEACHER_PRIVATE_NOTE_TARGET_NOT_FOUND' },
    });
    await ds.query(`UPDATE ser_occ SET canceled=true WHERE ser_id=$1 AND on_date=$2::date`, [serId, onDate]);
    await expect(service.write(teacherId, payload({ expectedVersion: 1 }))).rejects.toMatchObject({
      response: { code: 'TEACHER_PRIVATE_NOTE_LESSON_NOT_COMPLETED' },
    });
    await ds.query(`UPDATE ser_occ SET canceled=false WHERE ser_id=$1 AND on_date=$2::date`, [serId, onDate]);
  });

  it('강사 최근 내역은 자기 영수증 metadata만, 관리자 학생별 모음만 본문·작성자를 반환한다', async () => {
    const mine = await service.receipts(teacherId);
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((item) => !Object.prototype.hasOwnProperty.call(item, 'body'))).toBe(true);
    expect((await service.receipts(otherTeacherId)).items).toEqual([]);
    const admin = await service.studentNotes(studentId);
    expect(admin.studentId).toBe(studentId);
    expect(admin.items[0]).toMatchObject({ studentId, authorId: teacherId, authorName: '특이사항 강사' });
    expect(admin.items[0].body.length).toBeGreaterThan(0);
    await expect(service.studentNotes(9_007_199_254_740_000)).rejects.toMatchObject({
      response: { code: 'STUDENT_NOT_FOUND' },
    });
  });

  it('직접 INSERT와 receipt 없는 본문 UPDATE는 지연 제약이 commit에서 되돌린다', async () => {
    await expect(ds.transaction((m) => m.query(
      `INSERT INTO teacher_private_note(student_id,ser_id,on_date,author_id,body)
       VALUES($1,$2,$3::date,$4,'직접 삽입')`, [otherStudentId, serId, onDate, otherTeacherId],
    ))).rejects.toThrow(/teacher_private_note_receipt_required|write receipt is required/);
    const [current] = await ds.query(
      `SELECT id,body,version FROM teacher_private_note WHERE author_id=$1 AND ser_id=$2 AND on_date=$3::date AND student_id=$4`,
      [teacherId, serId, onDate, studentId],
    );
    await expect(ds.transaction((m) => m.query(
      `UPDATE teacher_private_note SET body='직접 수정',version=version+1 WHERE id=$1`, [current.id],
    ))).rejects.toThrow(/teacher_private_note_receipt_required|write receipt is required/);
    const [after] = await ds.query(`SELECT body,version FROM teacher_private_note WHERE id=$1`, [current.id]);
    expect(after).toEqual({ body: current.body, version: current.version });
  });
});
