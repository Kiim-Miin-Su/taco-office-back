/** @file-guide
 * 목적: BOC-08D-02 일반 자료요청의 담당 범위·멱등·상태 전이·첨부·수신확인·DB 우회 방어를 검증한다.
 * 책임/재사용: 스크래치 PostgreSQL에서 실제 service와 migration 제약을 함께 사용하고 외부 발송은 하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · migration 1767900000000
 */

import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { MaterialRequestsService } from '../src/modules/material-requests/material-requests.service';
import { FilesService } from '../src/modules/files/files.service';
import { FileRow } from '../src/entities';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

const TEACHER = 9_985_101;
const OTHER_TEACHER = 9_985_102;
const MANAGER = 9_985_103;
const STUDENT = 9_985_201;
const OTHER_STUDENT = 9_985_202;
const SER = 99_985_301;
const KIND = 'matreq-test';

const teacher = { id: TEACHER, name: '자료 강사', role: 'teacher' };
const manager = { id: MANAGER, name: '자료 실장', role: 'manager' };
const uuid = (suffix: number): string => `98510000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

d('BOC-08D-02 일반 자료요청 — 실제 DB', () => {
  let ds: DataSource;
  let svc: MaterialRequestsService;

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    svc = new MaterialRequestsService(ds);
    await ds.query(`INSERT INTO staff(id,name,login_id,email,role,active) VALUES
      ($1,'자료 강사','matreq-teacher','matreq-teacher@test.invalid','teacher',TRUE),
      ($2,'다른 강사','matreq-other','matreq-other@test.invalid','teacher',TRUE),
      ($3,'자료 실장','matreq-manager','matreq-manager@test.invalid','manager',TRUE)
      ON CONFLICT(id) DO NOTHING`, [TEACHER, OTHER_TEACHER, MANAGER]);
    await ds.query(`INSERT INTO stu(id,name,grade) VALUES
      ($1,'자료 학생','G7'),($2,'다른 학생','G8') ON CONFLICT(id) DO NOTHING`, [STUDENT, OTHER_STUDENT]);
    await ds.query(`INSERT INTO kind(key,name,color,cap,grp,rep,rep_form,sort)
      VALUES($1,'자료요청 시험','#123456',4,'lesson',TRUE,'dev',9998) ON CONFLICT(key) DO NOTHING`, [KIND]);
    await ds.query(`INSERT INTO ser(id,kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
      VALUES($1,$2,$3,'offline',600,660,'ONCE','2026-10-01','2027-12-31','자료요청 담당 수업') ON CONFLICT(id) DO NOTHING`,
    [SER, KIND, TEACHER]);
    await ds.query(`INSERT INTO ser_stu(ser_id,student_id,from_date,to_date)
      VALUES($1,$2,'2026-10-01',NULL) ON CONFLICT(ser_id,student_id) DO NOTHING`, [SER, STUDENT]);
  });

  afterEach(async () => {
    await ds.query(`DELETE FROM noti WHERE to_id=ANY($1::bigint[]) OR from_id=ANY($1::bigint[])`, [[TEACHER, OTHER_TEACHER, MANAGER]]);
    await ds.query(`DELETE FROM material_request WHERE teacher_id=ANY($1::bigint[])`, [[TEACHER, OTHER_TEACHER]]);
    await ds.query(`DELETE FROM file WHERE kind='material-request' AND uploaded_by=ANY($1::bigint[])`, [[TEACHER, OTHER_TEACHER, MANAGER]]);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM ser_stu WHERE ser_id=$1`, [SER]);
    await ds.query(`DELETE FROM ser WHERE id=$1`, [SER]);
    await ds.query(`DELETE FROM stu WHERE id=ANY($1::bigint[])`, [[STUDENT, OTHER_STUDENT]]);
    await ds.query(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [[TEACHER, OTHER_TEACHER, MANAGER]]);
    await ds.query(`DELETE FROM kind WHERE key=$1`, [KIND]);
    await ds.destroy();
  });

  it('담당 학생 요청을 한 번만 만들고 같은 actor·key·payload 재시도만 수렴시킨다', async () => {
    const input = {
      studentId: STUDENT, kind: 'worksheet' as const, neededOn: '2026-11-01', body: '분수 연산 워크시트', requestKey: uuid(1),
    };
    const first = await svc.create(teacher, input);
    expect(first).toMatchObject({ replayed: false, item: { state: 'received', version: 1, studentId: STUDENT } });
    await expect(svc.create(teacher, input)).resolves.toMatchObject({ replayed: true, item: { id: first.item.id } });
    await expect(svc.create(teacher, { ...input, body: '다른 내용' }))
      .rejects.toMatchObject({ response: { code: 'MATERIAL_REQUEST_KEY_REUSED' } });
    await expect(svc.create(teacher, { ...input, studentId: OTHER_STUDENT, requestKey: uuid(2) }))
      .rejects.toMatchObject({ response: { code: 'MATERIAL_REQUEST_STUDENT_NOT_ASSIGNED' } });
    const [{ events, notices }] = await ds.query(`SELECT
      (SELECT count(*)::int FROM material_request_event WHERE material_request_id=$1) AS events,
      (SELECT count(*)::int FROM noti WHERE link=$2 AND to_id=$3) AS notices`,
    [first.item.id, `/books?tab=requests&request=${first.item.id}`, MANAGER]);
    expect(events).toBe(1);
    expect(notices).toBe(1);
  });

  it('접수→준비→내부 파일 전달→강사 수신 확인을 version과 actor 이력으로 보존한다', async () => {
    const made = await svc.create(teacher, {
      studentId: STUDENT, kind: 'test_paper', neededOn: '2026-11-02', body: '중간고사 대비 시험지', requestKey: uuid(10),
    });
    await expect(svc.transition(manager, made.item.id, {
      action: 'delivered', expectedVersion: 1, requestKey: uuid(11), files: [],
    })).rejects.toMatchObject({ response: { code: 'MATERIAL_REQUEST_DELIVERY_FILE_REQUIRED' } });

    const preparing = await svc.transition(manager, made.item.id, {
      action: 'preparing', expectedVersion: 1, requestKey: uuid(12),
    });
    expect(preparing.item).toMatchObject({ state: 'preparing', version: 2, assignedTo: MANAGER });
    await expect(svc.transition(manager, made.item.id, {
      action: 'rejected', expectedVersion: 1, requestKey: uuid(13), reason: '중복',
    })).rejects.toMatchObject({ response: { code: 'MATERIAL_REQUEST_STALE' } });

    const delivered = await svc.transition(manager, made.item.id, {
      action: 'delivered', expectedVersion: 2, requestKey: uuid(14),
      files: [{ kind: 'material-request', name: '시험지.pdf', base64: Buffer.from('actual-pdf').toString('base64') }],
    });
    expect(delivered.item).toMatchObject({ state: 'delivered', version: 3, assignedTo: MANAGER, deliveredBy: MANAGER });
    expect(delivered.item.files).toEqual([expect.objectContaining({ purpose: 'delivery', name: '시험지.pdf' })]);

    const fileId = delivered.item.files[0]!.id;
    const files = new FilesService(ds.getRepository(FileRow));
    await expect(files.readAuthorized(teacher, fileId)).resolves.toMatchObject({ kind: 'material-request' });
    await expect(files.readAuthorized({ id: OTHER_TEACHER, name: '다른 강사', role: 'teacher' }, fileId))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await expect(files.readAuthorized({ ...manager, perms: { canGpaPack: false } }, fileId))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });

    const ack = await svc.acknowledge(teacher, made.item.id, { expectedVersion: 3, requestKey: uuid(15) });
    expect(ack.item).toMatchObject({ state: 'delivered', version: 4 });
    expect(ack.item.acknowledgedAt).not.toBeNull();
    expect(ack.item.events.map((event) => [event.action, event.resultVersion]))
      .toEqual([['created', 1], ['preparing', 2], ['delivered', 3], ['acknowledged', 4]]);
  });

  it('직접 쓰기는 event receipt와 전달 파일이 없으면 지연 제약에서 거절한다', async () => {
    await ds.transaction(async (m) => {
      await m.query('SAVEPOINT direct_without_event');
      await m.query(`INSERT INTO material_request
        (teacher_id,student_id,kind,needed_on,body,request_key)
        VALUES($1,$2,'other','2026-11-03','직접 쓰기',$3)`, [TEACHER, STUDENT, uuid(20)]);
      let message = '';
      try {
        await m.query('SET CONSTRAINTS material_request_event_complete IMMEDIATE');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      await m.query('ROLLBACK TO SAVEPOINT direct_without_event');
      expect(message).toContain('material request final state must have an event receipt');
    });

    const made = await svc.create(teacher, {
      studentId: STUDENT, kind: 'other', neededOn: '2026-11-04', body: 'DB 제약', requestKey: uuid(21),
    });
    const prepared = await svc.transition(manager, made.item.id, {
      action: 'preparing', expectedVersion: 1, requestKey: uuid(22),
    });
    await ds.transaction(async (m) => {
      await m.query('SAVEPOINT delivery_without_file');
      await m.query(`WITH changed AS (
          UPDATE material_request SET state='delivered',row_version=3,delivered_by=$2,delivered_at=now()
           WHERE id=$1 RETURNING id
        ) INSERT INTO material_request_event
          (material_request_id,action,from_state,to_state,actor_id,request_key,payload_sha256,result_version)
          SELECT id,'delivered','preparing','delivered',$2,$3,repeat('a',64),3 FROM changed`,
      [prepared.item.id, MANAGER, uuid(23)]);
      let message = '';
      try {
        await m.query('SET CONSTRAINTS material_request_event_complete IMMEDIATE');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      await m.query('ROLLBACK TO SAVEPOINT delivery_without_file');
      expect(message).toContain('delivered material request requires an internal file');
    });
  });
});
