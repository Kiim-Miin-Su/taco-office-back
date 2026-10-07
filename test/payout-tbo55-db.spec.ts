/** @file-guide
 * 목적: BO-09D-02 명시 Kinder 표식·진단/모의 총액·일반 그룹·실제 접점 연강을 실제 SQL projection으로 검증한다.
 * 책임/재사용: 공용 payoutSheet만 호출하고 테스트 계산식을 제품 구현으로 복제하지 않는다. 전체 transaction은 rollback한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-09D2-PAYOUT-CALCULATOR-2026-10-08.md · docs/contracts/db/erd.dbml
 */
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { payoutSheet } from '../src/lib/payout-sheet';
import { TEST_URL, assertScratch } from './db';

const d = TEST_URL && /localhost|127\.0\.0\.1/.test(TEST_URL) ? describe : describe.skip;
jest.setTimeout(60_000);

d('TBO-55 BO-09D-02 공용 급여 계산기 — 실제 DB projection', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error('BO-09D-02 DB 회귀는 로컬 scratch에서만 실행한다');
    ds = new DataSource({ ...dataSourceOptions, url, name: `payout-tbo55-${Date.now()}` } as typeof dataSourceOptions);
    await ds.initialize();
  });

  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('명시 표식만 Kinder로 계산하고 진단/모의는 총15,000원, 일반 그룹은 기존 가산, 연강은 마지막 종료+N시간을 쓴다', async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      let savepointSeq = 0;
      const rejectsConstraint = async (sql: string, params: unknown[], constraint: string) => {
        const savepoint = `t55_guard_${++savepointSeq}`;
        await q.query(`SAVEPOINT ${savepoint}`);
        let caught: unknown;
        try { await q.query(sql, params); } catch (error) { caught = error; }
        await q.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await q.query(`RELEASE SAVEPOINT ${savepoint}`);
        expect(caught).toMatchObject({ constraint });
      };
      const teacher = 99261;
      const actor = 99262;
      const students = [992611, 992612, 992613];
      const now = new Date();
      const lessonDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      const previousDate = new Date(new Date(`${lessonDate}T00:00:00Z`).getTime() - 86400e3).toISOString().slice(0, 10);
      const month = lessonDate.slice(0, 7);
      const afterDate = new Date(new Date(`${lessonDate}T00:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);
      await q.query(`INSERT INTO staff(id,name,email,role,active) VALUES
        ($1,'T55 급여 강사','t55-pay-teacher@test.local','teacher',true),
        ($2,'T55 급여 대표','t55-pay-ceo@test.local','ceo',true)`, [teacher, actor]);
      await q.query(`INSERT INTO stu(id,name,grade) VALUES
        ($1,'명시 Kinder','G9'),($2,'일반 학생A','K'),($3,'일반 학생B','G10')`, students);
      await q.query(`INSERT INTO wage(staff_id,rate,from_date,reason) VALUES($1,40000,$2::date,'T55')`, [teacher, previousDate]);
      await q.query(`INSERT INTO payout_bonus_rule(kind,kind_key,amount,from_date,set_by) VALUES
        ('per_session','mock',15000,$1::date,$2),('per_session','diagx',15000,$1::date,$2),
        ('kinder_hourly',NULL,10000,$1::date,$2),('group_per_student',NULL,5000,$1::date,$2)`, [previousDate, actor]);
      // 학생2는 grade=K지만 표식이 없으므로 일반 학생이다. 학생1만 별도 event로 Kinder다.
      await q.query(`INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,reason,set_by)
        VALUES($1,1,true,($2::date::timestamp AT TIME ZONE 'Asia/Seoul'),'T55 명시 표식',$3)`, [students[0], lessonDate, actor]);
      await rejectsConstraint(
        `INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,set_by)
         VALUES($1,3,false,(now()+interval '2 months'),$2)`, [students[0], actor], 'stu_kinder_marker_version_step',
      );
      await rejectsConstraint(
        `INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,set_by)
         VALUES($1,1,true,(now()-interval '1 second'),$2)`, [students[1], actor], 'stu_kinder_marker_future_only',
      );
      await rejectsConstraint(
        `UPDATE stu_kinder_marker SET marked=false WHERE student_id=$1`, [students[0]], 'stu_kinder_marker_immutable',
      );
      await rejectsConstraint(
        `DELETE FROM stu_kinder_marker WHERE student_id=$1`, [students[0]], 'stu_kinder_marker_immutable',
      );

      const made: Record<string, number> = {};
      const add = async (name: string, kindKey: string, startMin: number, durMin: number, studentIds: number[], submittedMin: number, onDate = lessonDate) => {
        const [s] = await q.query(`INSERT INTO ser(kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
          VALUES($1,$2,'offline',$3,$4,'ONCE',$5::date,$5::date,$6) RETURNING id`,
        [kindKey, teacher, startMin, startMin + durMin, onDate, `T55 ${name}`]) as Array<{ id: string }>;
        const serId = Number(s.id); made[name] = serId;
        for (const studentId of studentIds) await q.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES($1,$2)`, [serId, studentId]);
        await q.query(`INSERT INTO ser_occ(ser_id,on_date,canceled,span) VALUES($1,$2::date,false,tstzrange(
          ($2::date + make_interval(mins=>$3))::timestamp AT TIME ZONE 'Asia/Seoul',
          ($2::date + make_interval(mins=>$4))::timestamp AT TIME ZONE 'Asia/Seoul','[)'))`,
        [serId, onDate, startMin, startMin + durMin]);
        await q.query(`INSERT INTO rep(ser_id,on_date,teacher_id,kind_key,body,state,written_at,submitted_at)
          VALUES($1,$2::date,$3,$4,'{"content":"T55","progress":"T55","homework":"T55"}'::jsonb,'wait',
          ($2::date + make_interval(mins=>$5))::timestamp AT TIME ZONE 'Asia/Seoul',
          ($2::date + make_interval(mins=>$5))::timestamp AT TIME ZONE 'Asia/Seoul')`,
        [serId, onDate, teacher, kindKey, submittedMin]);
      };

      await add('kinder', 'class', 9 * 60, 90, [students[0]], 11 * 60);
      await add('mock', 'mock', 12 * 60, 120, [students[0], students[1]], 14 * 60 + 59);
      await add('diag', 'diagx', 15 * 60, 30, [students[0], students[1]], 16 * 60);
      await add('group', 'class', 16 * 60, 60, [students[1], students[2]], 19 * 60 + 30);
      await add('touch', 'class', 17 * 60, 60, [students[1]], 20 * 60 + 30);
      // 월 경계 밖 전 회차와 맞닿는다. 현재 월 행만 읽어 연강을 세면 90분 지각 차감이 생긴다.
      await add('boundary-prev', 'class', 23 * 60, 60, [students[1]], 26 * 60 + 30, previousDate);
      await add('boundary-current', 'class', 0, 60, [students[1]], 2 * 60 + 30);

      const sheet = await payoutSheet(q, teacher, month, afterDate, 12 * 60);
      const by = (name: string) => sheet.lessons.find((row) => row.serId === made[name])!;
      expect(by('kinder')).toMatchObject({ pay: 60000, bonus: 15000, bonusParts: [{ kind: 'kinder_hourly', amount: 15000 }] });
      expect(by('mock')).toMatchObject({ pay: 0, bonus: 15000, unitRate: 0, bonusParts: [{ kind: 'per_session', amount: 15000 }] });
      expect(by('diag')).toMatchObject({ pay: 0, bonus: 15000, unitRate: 0, bonusParts: [{ kind: 'per_session', amount: 15000 }] });
      expect(by('group')).toMatchObject({ pay: 40000, bonus: 10000, lateCut: 0 });
      expect(by('touch')).toMatchObject({ pay: 40000, bonus: 0, lateCut: 0 });
      expect(by('boundary-current')).toMatchObject({ pay: 40000, bonus: 0, lateCut: 0 });
      expect(sheet.lessons.some((row) => row.serId === made['boundary-prev'])).toBe(false);
      expect(sheet.agg).toMatchObject({ writtenCount: 6, gross: 235000, bonus: 55000, lateCut: 0 });
      expect(sheet.incomeTax).toBe(7050);
      expect(sheet.localTax).toBe(705);
      expect(sheet.net).toBe(227245);

      // 확정된 근거 줄은 marker/rule 후속 변경과 무관하게 읽히는 기존 snapshot 계약을 유지한다.
      await q.query(`INSERT INTO payout(staff_id,year_month,hours,gross,late_rep_cut,income_tax,local_tax,net,state,confirmed_by,confirmed_at)
        VALUES($1,$2,1.5,75000,0,2250,220,72530,'confirmed',$3,now())`, [teacher, month, actor]);
      const [payout] = await q.query(`SELECT id FROM payout WHERE staff_id=$1 AND year_month=$2`, [teacher, month]) as Array<{ id: string }>;
      await q.query(`INSERT INTO payout_line(payout_id,ser_id,on_date,kind_key,hours,unit_rate,amount,cut,bonus,bonus_detail,correction)
        VALUES($1,$2,$3::date,'class',1.5,40000,60000,0,15000,'[{"kind":"kinder_hourly","amount":15000}]'::jsonb,false)`,
      [Number(payout.id), made.kinder, lessonDate]);
      const frozen = await payoutSheet(q, teacher, month, afterDate, 12 * 60);
      expect(frozen.confirmed).toMatchObject({ lined: true });
      expect(frozen.lessons.find((row) => row.serId === made.kinder)).toMatchObject({ pay: 60000, bonus: 15000, frozen: true });
      expect(frozen.agg.gross).toBe(75000);
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
  });
});
