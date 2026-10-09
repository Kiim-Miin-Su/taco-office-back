/** @file-guide
 * 목적: BOC-11E 시간당 단가 current/request/event와 실제 회차 시간 청구 계산을 PostgreSQL에서 회귀한다.
 * 책임/재사용: HourlyRatesService와 invoiceLines를 직접 호출하며 테스트용 계산식을 제품 규칙으로 복제하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11E-HOURLY-RATE-POLICY-2026-10-09.md · migration 1768600000000
 */
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { addDays, todayKst } from '../src/lib/kst';
import { HourlyRatesService } from '../src/modules/accounting/hourly-rates.service';
import { invoiceLines } from '../src/modules/accounting/invoice-lines';
import { assertScratch, blockedBy, TEST_URL } from './db';

const d = TEST_URL && /localhost|127\.0\.0\.1/.test(TEST_URL) ? describe : describe.skip;
jest.setTimeout(60_000);

d('TBO-55 BOC-11E 시간당 단가 정책과 실제 시간 청구', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, name: `hourly-rate-${Date.now()}` } as typeof dataSourceOptions);
    await ds.initialize();
  });

  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('일반·Kinder·그룹·학생 예외를 기간/version으로 보존하고 30/60/90분 actual span에 적용한다', async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const actor = 99400;
      const students = [99401, 99402, 99403, 99404];
      const today = todayKst();
      const firstDate = addDays(today, 2);
      const replacementDate = addDays(firstDate, 1);
      await q.query(`INSERT INTO staff(id,name,email,role,active) VALUES($1,'시간당 대표','hourly-rate@test.local','ceo',true)`, [actor]);
      await q.query(`INSERT INTO stu(id,name,grade) VALUES
        ($1,'일반 학생','G8'),($2,'Kinder 학생','G9'),($3,'그룹 예외 학생','G10'),($4,'그룹 일반 학생','G11')`, students);
      await q.query(`INSERT INTO kind(key,name,color,cap,grp,rep,sort) VALUES('class','수업','#4F46E5',8,'lesson',true,1)
        ON CONFLICT(key) DO NOTHING`);
      await q.query(`INSERT INTO sub(key,name,color,kind_key,active,sort) VALUES('hourly-sub','시간당 과목','#A85764','class',true,1)
        ON CONFLICT(key) DO NOTHING`);
      await q.query(`INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,reason,set_by)
        VALUES($1,1,true,($2::date::timestamp AT TIME ZONE 'Asia/Seoul'),'명시 Kinder',$3)`, [students[1], firstDate, actor]);

      // 서비스의 모든 query/transaction을 같은 rollback 가능한 QueryRunner에 묶는다.
      let serviceTx = 0;
      const local = {
        query: (sql: string, params?: unknown[]) => q.query(sql, params),
        transaction: async <T>(run: (manager: EntityManager) => Promise<T>) => {
          const savepoint = `hourly_service_${++serviceTx}`;
          await q.query(`SAVEPOINT ${savepoint}`);
          try {
            const result = await run(q.manager);
            await q.query(`RELEASE SAVEPOINT ${savepoint}`);
            return result;
          } catch (error) {
            await q.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await q.query(`RELEASE SAVEPOINT ${savepoint}`);
            throw error;
          }
        },
      } as unknown as DataSource;
      const svc = new HourlyRatesService(local);
      const create = (body: Record<string, unknown>) => svc.create(actor, { ...body, requestKey: randomUUID() } as never);

      const general = await create({ scope: 'general', hourlyAmount: 60_000, effectiveFrom: today, reason: '일반 기준' });
      const kinder = await create({ scope: 'kinder', hourlyAmount: 70_000, effectiveFrom: today, reason: 'Kinder 기준' });
      const group = await create({ scope: 'group', capacity: 2, hourlyAmount: 45_000, effectiveFrom: today, reason: '2인 기준' });
      const student = await create({
        scope: 'student', studentId: students[2], kindKey: 'class', hourlyAmount: 40_000,
        effectiveFrom: today, reason: '형제 할인',
      });
      expect(general).toMatchObject({ replayed: false, item: { scope: 'general', hourlyAmount: 60_000, state: 'current' } });
      expect(kinder.item).toMatchObject({ scope: 'kinder', hourlyAmount: 70_000 });
      expect(group.item).toMatchObject({ scope: 'group', capacity: 2, totalHourlyAmount: 90_000 });
      expect(student.item).toMatchObject({
        scope: 'student', studentId: students[2], hourlyAmount: 40_000, basisHourlyAmount: 60_000, basisPercent: 66.7,
      });

      const retryKey = randomUUID();
      const retryBody = { scope: 'group' as const, capacity: 3, hourlyAmount: 42_000, effectiveFrom: addDays(today, 20), reason: '3인 예약', requestKey: retryKey };
      const scheduled = await svc.create(actor, retryBody);
      expect((await svc.create(actor, retryBody)).replayed).toBe(true);
      await expect(svc.create(actor, { ...retryBody, hourlyAmount: 41_000 })).rejects.toMatchObject({
        response: { code: 'HOURLY_RATE_KEY_REUSED' },
      });
      await expect(create({ scope: 'general', hourlyAmount: 61_000, effectiveFrom: firstDate })).rejects.toMatchObject({
        response: { code: 'HOURLY_RATE_OVERLAP' },
      });

      const replacement = await svc.replace(actor, general.item.id, {
        expectedVersion: 1, hourlyAmount: 80_000, effectiveFrom: replacementDate,
        reason: '일반 기준 인상', requestKey: randomUUID(),
      });
      expect(replacement.item).toMatchObject({ scope: 'general', hourlyAmount: 80_000, state: 'scheduled', version: 1 });
      expect((await svc.list()).find((item) => item.id === general.item.id)).toMatchObject({
        state: 'current', version: 2, canEdit: false, canRetire: false,
      });
      await expect(svc.replace(actor, general.item.id, {
        expectedVersion: 1, hourlyAmount: 81_000, effectiveFrom: addDays(replacementDate, 1),
        reason: 'stale 검사', requestKey: randomUUID(),
      })).rejects.toMatchObject({ response: { code: 'HOURLY_RATE_STALE' } });
      await expect(svc.retire(actor, general.item.id, {
        expectedVersion: 2, reason: '교체 원본 재종료 차단', requestKey: randomUUID(),
      })).rejects.toMatchObject({ response: { code: 'HOURLY_RATE_NOT_ACTIVE' } });
      const retired = await svc.retire(actor, scheduled.item.id, {
        expectedVersion: 1, reason: '예약 취소', requestKey: randomUUID(),
      });
      expect(retired.item).toMatchObject({ state: 'voided', version: 2, canEdit: false, canRetire: false });
      const retiringToday = await create({
        scope: 'group', capacity: 5, hourlyAmount: 41_000, effectiveFrom: today, effectiveTo: today, reason: '당일 종료 검수',
      });
      const retiredToday = await svc.retire(actor, retiringToday.item.id, {
        expectedVersion: 1, reason: '오늘까지만 적용', requestKey: randomUUID(),
      });
      expect(retiredToday.item).toMatchObject({ state: 'current', version: 2, canEdit: false, canRetire: false });
      await expect(svc.retire(actor, retiringToday.item.id, {
        expectedVersion: 2, reason: '중복 종료 차단', requestKey: randomUUID(),
      })).rejects.toMatchObject({ response: { code: 'HOURLY_RATE_NOT_ACTIVE' } });
      await expect(svc.replace(actor, retiringToday.item.id, {
        expectedVersion: 2, hourlyAmount: 42_000, effectiveFrom: addDays(today, 1),
        reason: '종료 뒤 교체 차단', requestKey: randomUUID(),
      })).rejects.toMatchObject({ response: { code: 'HOURLY_RATE_NOT_ACTIVE' } });

      const lesson = async (name: string, date: string, startMin: number, durationMin: number, studentIds: number[]) => {
        const [ser] = await q.query(`INSERT INTO ser(kind_key,sub_key,mode,start_min,end_min,rrule,from_date,to_date,title)
          VALUES('class','hourly-sub','offline',$1,$2,'ONCE',$3::date,$3::date,$4) RETURNING id`, [
          startMin, startMin + durationMin, date, `시간당 ${name}`,
        ]) as Array<{ id: string }>;
        for (const studentId of studentIds) {
          await q.query(`INSERT INTO ser_stu(ser_id,student_id) VALUES($1,$2)`, [ser.id, studentId]);
        }
        await q.query(`INSERT INTO ser_occ(ser_id,on_date,canceled,span) VALUES($1,$2::date,false,tstzrange(
          ($2::date + make_interval(mins=>$3))::timestamp AT TIME ZONE 'Asia/Seoul',
          ($2::date + make_interval(mins=>$4))::timestamp AT TIME ZONE 'Asia/Seoul','[)'))`, [
          ser.id, date, startMin, startMin + durationMin,
        ]);
      };
      await lesson('일반30', firstDate, 540, 30, [students[0]]);
      await lesson('일반교체60', replacementDate, 540, 60, [students[0]]);
      await lesson('Kinder90', firstDate, 660, 90, [students[1]]);
      await lesson('그룹60', firstDate, 840, 60, [students[2], students[3]]);

      const priceLines = async (studentId: number, date: string) => invoiceLines(q, studentId, date.slice(0, 7));
      const generalPrices = [
        ...(await priceLines(students[0], firstDate)),
        ...(replacementDate.slice(0, 7) === firstDate.slice(0, 7) ? [] : await priceLines(students[0], replacementDate)),
      ].map((row) => Number(row.unit_price));
      expect(generalPrices).toEqual(expect.arrayContaining([30_000, 80_000]));
      expect((await priceLines(students[1], firstDate)).map((row) => Number(row.unit_price))).toContain(105_000);
      expect((await priceLines(students[2], firstDate)).map((row) => Number(row.unit_price))).toContain(40_000);
      expect((await priceLines(students[3], firstDate)).map((row) => Number(row.unit_price))).toContain(45_000);

      await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await q.query(`SET CONSTRAINTS ALL DEFERRED`);
      const old = (await q.query(`SELECT row_version,to_char(effective_to,'YYYY-MM-DD') AS effective_to
        FROM hourly_rate_policy WHERE id=$1`, [general.item.id]))[0] as {
        row_version: number; effective_to: string;
      };
      expect(Number(old.row_version)).toBe(2);
      expect(String(old.effective_to)).toBe(addDays(replacementDate, -1));
      expect(await q.query(`SELECT action,result_version FROM hourly_rate_policy_event WHERE policy_id=$1 ORDER BY result_version`, [general.item.id]))
        .toEqual([{ action: 'created', result_version: 1 }, { action: 'superseded', result_version: 2 }]);

      expect(await blockedBy(q, `UPDATE hourly_rate_policy_event SET reason='변조' WHERE policy_id=$1`, [general.item.id]))
        .toContain('hourly rate policy audit history is immutable');
      await q.query(`SAVEPOINT missing_receipt`);
      let receiptError: unknown;
      try {
        await q.query(`INSERT INTO hourly_rate_policy(scope,capacity,hourly_amount,effective_from,created_by,updated_by)
          VALUES('group',99,99999,$1::date,$2,$2)`, [addDays(today, 100), actor]);
        await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      } catch (error) { receiptError = error; }
      await q.query(`ROLLBACK TO SAVEPOINT missing_receipt`);
      await q.query(`RELEASE SAVEPOINT missing_receipt`);
      expect(receiptError).toMatchObject({ constraint: 'hourly_rate_policy_receipt_required' });
    } finally {
      if (q.isTransactionActive) await q.rollbackTransaction();
      await q.release();
    }
  });
});
