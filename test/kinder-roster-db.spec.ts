/** @file-guide
 * 목적: BO-09E-01 Kinder 지연 제약이 직접 SQL·90일 밖·진단 그룹을 최종 commit 상태로 판정하는지 검증한다.
 * 책임/재사용: migration의 정본 trigger를 실제 PostgreSQL transaction에서 실행하고 전부 rollback한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-09E1-KINDER-ROSTER-GUARD-2026-10-08.md · docs/contracts/db/erd.dbml
 */
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { StudentKinderService } from '../src/modules/students/student-kinder.service';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
import { TEST_URL, assertScratch } from './db';

const d = TEST_URL && /localhost|127\.0\.0\.1/.test(TEST_URL) ? describe : describe.skip;
jest.setTimeout(60_000);

d('BO-09E-01 Kinder roster deferred DB guard', () => {
  let ds: DataSource;
  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, name: `kinder-roster-${Date.now()}` } as typeof dataSourceOptions);
    await ds.initialize();
    // migration-only scratch에서도 도메인 정본 키를 명시해 전체 스위트 실행 순서에 기대지 않는다.
    await ds.query(`INSERT INTO kind(key,name,color,cap,grp,rep) VALUES
      ('class','수업','#4A5461',4,'lesson',true),
      ('diagx','진단고사','#6F798A',8,'intake',true)
      ON CONFLICT (key) DO NOTHING`);
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('최종상태의 class 1명만 허용하고 90일 밖 충돌·marker 직접 쓰기를 막되 진단 그룹은 유지한다', async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const actor = 99320;
      const students = [99321, 99322, 99323];
      const future = new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10);
      await q.query(`INSERT INTO staff(id,name,email,role,active) VALUES($1,'Kinder DB 대표','kinder-db@test.local','ceo',true)`, [actor]);
      await q.query(`INSERT INTO stu(id,name,grade) VALUES
        ($1,'Kinder 명시','G9'),($2,'일반 A','K'),($3,'일반 B','G10')`, students);
      const [one] = await q.query(`INSERT INTO ser(kind_key,mode,start_min,end_min,rrule,from_date,title)
        VALUES('class','offline',600,660,'WEEKLY:MO',$1::date,'Kinder DB class') RETURNING id`, [future]) as Array<{ id: string }>;
      await q.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES($1,$2)`, [one!.id, students[0]]);
      await q.query(`INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,reason,set_by)
        VALUES($1,1,true,now()+interval '1 day','명시 표식',$2)`, [students[0], actor]);
      await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await q.query(`SET CONSTRAINTS ALL DEFERRED`);
      const kinder = new StudentKinderService(ds);
      const unmarked = await kinder.create(actor, students[0], {
        marked: true, effectiveFrom: new Date(Date.now() + 2 * 86400_000).toISOString(),
        reason: '후속 Kinder 예약', expectedVersion: 1,
      }, q);
      expect(unmarked).toMatchObject({ studentId: students[0], version: 2, marked: true, setBy: actor });
      await expect(new ScheduleWriteService(ds).create({
        kindKey: 'class', subKey: null, mode: 'offline', fromDate: future, toDate: future,
        rrule: 'ONCE', startMin: 960, endMin: 1020, teacherId: null, roomId: null,
        title: '공통 writer 우회 검사', studentIds: [students[0], students[1]],
      }, actor, q)).rejects.toMatchObject({ response: expect.objectContaining({
        code: 'KINDER_GROUP_CONFLICT', studentIds: [students[0], students[1]],
      }) });

      await q.query(`SAVEPOINT kinder_two_students`);
      let rosterError: unknown;
      try {
        await q.query(`INSERT INTO ser_stu(ser_id,student_id,from_date) VALUES($1,$2,$3::date)`, [one!.id, students[1], future]);
        await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      } catch (error) { rosterError = error; }
      await q.query(`ROLLBACK TO SAVEPOINT kinder_two_students`);
      await q.query(`RELEASE SAVEPOINT kinder_two_students`);
      expect(rosterError).toMatchObject({ constraint: 'kinder_roster_one_to_one' });
      await q.query(`SET CONSTRAINTS ALL DEFERRED`);

      const [group] = await q.query(`INSERT INTO ser(kind_key,mode,start_min,end_min,rrule,from_date,title)
        VALUES('class','offline',720,780,'ONCE',$1::date,'marker direct conflict') RETURNING id`, [future]) as Array<{ id: string }>;
      await q.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES($1,$2),($1,$3)`, [group!.id, students[1], students[2]]);
      await expect(kinder.create(actor, students[1], {
        marked: true, effectiveFrom: new Date(Date.now() + 86400_000).toISOString(),
        reason: '서비스 충돌', expectedVersion: 0,
      }, q)).rejects.toMatchObject({ response: expect.objectContaining({
        code: 'KINDER_GROUP_CONFLICT', serId: Number(group!.id), studentIds: [students[1], students[2]],
      }) });
      await q.query(`SAVEPOINT kinder_marker_direct`);
      let markerError: unknown;
      try {
        await q.query(`INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,reason,set_by)
          VALUES($1,1,true,now()+interval '1 day','직접 쓰기',$2)`, [students[1], actor]);
        await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      } catch (error) { markerError = error; }
      await q.query(`ROLLBACK TO SAVEPOINT kinder_marker_direct`);
      await q.query(`RELEASE SAVEPOINT kinder_marker_direct`);
      expect(markerError).toMatchObject({ constraint: 'kinder_roster_one_to_one' });
      await q.query(`SET CONSTRAINTS ALL DEFERRED`);

      const [diagnostic] = await q.query(`INSERT INTO ser(kind_key,mode,start_min,end_min,rrule,from_date,title)
        VALUES('diagx','offline',840,900,'ONCE',$1::date,'진단 그룹') RETURNING id`, [future]) as Array<{ id: string }>;
      await q.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES($1,$2),($1,$3)`, [diagnostic!.id, students[0], students[1]]);
      await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    } finally {
      if (q.isTransactionActive) await q.rollbackTransaction();
      await q.release();
    }
  });

  it('표시 변경과 명단 추가 동시 요청은 공용 Kinder 잠금 뒤 최신 반대편 상태를 다시 보고 한쪽을 거절한다', async () => {
    const actor = 99330;
    const students = [99331, 99332];
    const future = new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10);
    let serId = 0;
    try {
      await ds.query(`INSERT INTO staff(id,name,email,role,active) VALUES($1,'Kinder 경합 대표','kinder-race@test.local','ceo',true)`, [actor]);
      await ds.query(`INSERT INTO stu(id,name,grade) VALUES($1,'경합 A','G8'),($2,'경합 B','G9')`, students);
      const [ser] = await ds.query(`INSERT INTO ser(kind_key,mode,start_min,end_min,rrule,from_date,title)
        VALUES('class','offline',600,660,'WEEKLY:MO',$1::date,'Kinder 경합') RETURNING id`, [future]) as Array<{ id: string }>;
      serId = Number(ser!.id);
      await ds.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES($1,$2)`, [serId, students[0]]);

      const roster = ds.createQueryRunner();
      const marker = ds.createQueryRunner();
      await roster.connect(); await marker.connect();
      await roster.startTransaction(); await marker.startTransaction();
      try {
        await roster.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES($1,$2)`, [serId, students[1]]);
        await roster.query(`SET CONSTRAINTS ALL IMMEDIATE`); // 전역 Kinder 잠금을 commit까지 보유
        await marker.query(`INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,reason,set_by)
          VALUES($1,1,true,now()+interval '1 day','경합 표식',$2)`, [students[0], actor]);
        const markerCheck = marker.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await roster.commitTransaction();
        await expect(markerCheck).rejects.toMatchObject({ constraint: 'kinder_roster_one_to_one' });
        await marker.rollbackTransaction();
      } finally {
        if (roster.isTransactionActive) await roster.rollbackTransaction();
        if (marker.isTransactionActive) await marker.rollbackTransaction();
        await roster.release(); await marker.release();
      }
      expect(await ds.query(`SELECT student_id FROM ser_stu WHERE ser_id=$1 ORDER BY student_id`, [serId]))
        .toEqual([{ student_id: String(students[0]) }, { student_id: String(students[1]) }]);
      expect(await ds.query(`SELECT id FROM stu_kinder_marker WHERE student_id=$1`, [students[0]])).toEqual([]);
    } finally {
      if (serId) {
        await ds.query(`DELETE FROM ser_stu WHERE ser_id=$1`, [serId]);
        await ds.query(`DELETE FROM ser WHERE id=$1`, [serId]);
      }
      await ds.query(`DELETE FROM stu WHERE id=ANY($1::bigint[])`, [students]);
      await ds.query(`DELETE FROM staff WHERE id=$1`, [actor]);
    }
  });
});
