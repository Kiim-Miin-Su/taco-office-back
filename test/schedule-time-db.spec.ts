/** @file-guide
 * 목적: schedule-time-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { assertScratch, TEST_URL } from './db';
import { ScheduleTimeContract1757800000000, TIME_CHECKS } from '../src/migrations/1757800000000-schedule-time-contract';

const d = TEST_URL ? describe : describe.skip;
d('일정 시간 DB 최종 방어', () => {
  let ds: DataSource;
  let q: QueryRunner;
  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO kind(key,name,color,cap,grp) VALUES('time_test','시간검증','#000000',1,'lesson')`);
    await q.query(`INSERT INTO ser(id,kind_key,mode,start_min,end_min,rrule,from_date)
      VALUES(-780,'time_test','offline',600,660,'ONCE','2026-09-11')`);
    await q.query(`INSERT INTO exc(id,ser_id,on_date) VALUES(-780,-780,'2026-09-11')`);
    await q.query(`INSERT INTO ser_occ(id,ser_id,on_date,span) VALUES(-780,-780,'2026-09-11','[2026-09-11 10:00+09,2026-09-11 11:00+09)')`);
  });
  afterEach(async () => { if(q?.isTransactionActive) await q.rollbackTransaction(); if(q && !q.isReleased) await q.release(); });
  afterAll(async () => { if(ds?.isInitialized) await ds.destroy(); });
  it('정상 nullable/자정 종료/이동 회차와 이력 보존용 날짜 역전을 유지한다', async () => {
    await q.query(`UPDATE ser SET start_min=1430,end_min=1440,to_date='2026-09-10' WHERE id=-780`);
    await q.query(`UPDATE exc SET start_min=NULL,end_min=NULL WHERE id=-780`);
    await q.query(`UPDATE ser_occ SET span='[2026-09-12 23:50+09,2026-09-13 00:00+09)',canceled=true WHERE id=-780`);
    expect(Object.values(await new ScheduleTimeContract1757800000000().preflight(q)).every(n=>n===0)).toBe(true);
  });
  it('metadata와 고정 migration SQL이 같고 down/up 재적용이 행을 보존한다', async () => {
    const migration=new ScheduleTimeContract1757800000000();
    for(const c of TIME_CHECKS) {
      expect(ds.entityMetadatas.find(m=>m.tableName===c.table)!.checks.find(check=>check.name===c.name)?.expression).toBe(c.expression);
    }
    for(let round=0;round<2;round++) { await migration.down(q); await migration.up(q); }
    const rows=await q.query('SELECT conname,convalidated FROM pg_constraint WHERE conname=ANY($1) ORDER BY conname',[TIME_CHECKS.map(c=>c.name)]);
    expect(rows).toEqual(TIME_CHECKS.map(c=>({conname:c.name,convalidated:true})).sort((a,b)=>a.conname.localeCompare(b.conname)));
    expect(await q.query('SELECT 1 FROM ser_occ WHERE id=-780')).toHaveLength(1);
  });
  it.each([['ser','end_min=609','ser_time_check'],['exc','start_min=600,end_min=609','exc_time_check'],
    ['ser_occ',"span='empty'::tstzrange",'ser_occ_time_check']])('%s 오염이 있으면 고치거나 지우지 않고 preflight 실패',async(table,set,name)=>{
      const migration=new ScheduleTimeContract1757800000000(); await migration.down(q);
      await q.query(`UPDATE ${table} SET ${set} WHERE id=-780`);
      expect(await migration.preflight(q)).toMatchObject({[name]:1});
      await expect(migration.up(q)).rejects.toThrow('Schedule time preflight failed');
      expect(await q.query(`SELECT 1 FROM ${table} WHERE id=-780`)).toHaveLength(1);
      expect(await q.query('SELECT 1 FROM pg_constraint WHERE conname=ANY($1)',[TIME_CHECKS.map(c=>c.name)])).toHaveLength(0);
  });
  it.each(['start_min=-1','start_min=1440,end_min=1450','end_min=609','end_min=1081','end_min=1441'])('SER %s 거절', async set => {
    await expect(q.query(`UPDATE ser SET ${set} WHERE id=-780`)).rejects.toMatchObject({code:'23514',constraint:'ser_time_check'});
  });
  it.each(['start_min=-1','end_min=1441','start_min=600,end_min=609','start_min=600,end_min=1081'])('EXC %s 거절', async set => {
    await expect(q.query(`UPDATE exc SET ${set} WHERE id=-780`)).rejects.toMatchObject({code:'23514',constraint:'exc_time_check'});
  });
  it.each(['empty','(,2026-09-11 11:00+09)','[2026-09-11 10:00+09,)','[-infinity,infinity)',
    '[2026-09-11 10:00+09,2026-09-11 10:09+09)', '[2026-09-11 10:00+09,2026-09-11 18:01+09)',
    '[2026-09-11 23:55+09,2026-09-12 00:05+09)', '[2026-09-11 10:00:30+09,2026-09-11 11:00:30+09)',
    '(2026-09-11 10:00+09,2026-09-11 11:00+09]', '[2026-09-11 10:00+09,2026-09-11 11:00+09]'])('투영 span %s 거절', async span => {
    await expect(q.query('UPDATE ser_occ SET span=$1::tstzrange WHERE id=-780',[span])).rejects.toMatchObject({code:'23514',constraint:'ser_occ_time_check'});
  });
});
