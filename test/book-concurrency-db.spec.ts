/** @file-guide
 * 목적: 교재 판 활성화와 진도/총쪽수 갱신의 LIB-first 잠금 순서를 실제 동시 연결에서 검증한다.
 * 책임/재사용: BooksService 공개 메서드를 병렬 호출하고 C77 전용 행만 정리한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BooksService } from '../src/modules/books/books.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(30_000);

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

d('C77 교재 LIB-first 동시성', () => {
  let ds: DataSource;
  let svc: BooksService;
  const owner = 1881;
  const madeLibs: number[] = [];
  const madeStudents: number[] = [];
  const madeSeries: number[] = [];
  const madeKinds: string[] = [];
  const madeSubs: string[] = [];
  let serial = 0;

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    svc = new BooksService(ds.getRepository(Lead));
    await ds.query(
      `INSERT INTO staff (id,name,email,role,active) VALUES ($1,'동시성 담당','book-concurrency@test','admin',true)
       ON CONFLICT (id) DO UPDATE SET active=true`, [owner],
    );
  });

  afterEach(async () => {
    if (madeSeries.length) {
      await ds.query(`DELETE FROM ser_stu WHERE ser_id=ANY($1::bigint[])`, [madeSeries]);
      await ds.query(`DELETE FROM ser WHERE id=ANY($1::bigint[])`, [madeSeries]);
    }
    if (madeLibs.length) {
      await ds.query(`DELETE FROM hist WHERE (entity IN ('lib','vers','issue') AND ref_id IN (
        SELECT id FROM vers WHERE lib_id=ANY($1::bigint[])
        UNION SELECT id FROM issue WHERE lib_id=ANY($1::bigint[])
        UNION SELECT unnest($1::bigint[])
      )) OR by_id=$2`, [madeLibs, owner]);
      await ds.query(`DELETE FROM issue WHERE lib_id=ANY($1::bigint[])`, [madeLibs]);
      await ds.query(`DELETE FROM vers WHERE lib_id=ANY($1::bigint[])`, [madeLibs]);
      await ds.query(`DELETE FROM lib WHERE id=ANY($1::bigint[])`, [madeLibs]);
    }
    if (madeStudents.length) await ds.query(`DELETE FROM stu WHERE id=ANY($1::bigint[])`, [madeStudents]);
    if (madeSubs.length) await ds.query(`DELETE FROM sub WHERE key=ANY($1::text[])`, [madeSubs]);
    if (madeKinds.length) await ds.query(`DELETE FROM kind WHERE key=ANY($1::text[])`, [madeKinds]);
    madeLibs.length = 0;
    madeStudents.length = 0;
    madeSeries.length = 0;
    madeKinds.length = 0;
    madeSubs.length = 0;
  });
  afterAll(async () => {
    await ds?.query(`DELETE FROM staff WHERE id=$1 AND email='book-concurrency@test'`, [owner]);
    if (ds?.isInitialized) await ds.destroy();
  });

  async function lib(pages = 100): Promise<number> {
    const [row] = await ds.query(
      `INSERT INTO lib (code,title,pages) VALUES ($1,'동시성 교재',$2) RETURNING id`,
      [`C77-CONC-${Date.now()}-${serial++}`, pages],
    );
    const id = Number(row.id); madeLibs.push(id); return id;
  }

  it('서로 다른 판을 동시에 활성화해도 deadlock 없이 직렬화되고 현재 판은 하나다', async () => {
    const libId = await lib();
    const first = await svc.addVersion(owner, libId, { edition: 'v1', fromDate: '2099-01-01' });
    const second = await svc.addVersion(owner, libId, { edition: 'v2', fromDate: '2099-01-01' });
    const results = await Promise.all([
      svc.useVersion(owner, first.id),
      svc.useVersion(owner, second.id),
    ]);
    expect(results.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    const current = await ds.query(
      `SELECT id FROM vers WHERE lib_id=$1 AND from_date<=current_date
       ORDER BY from_date DESC,activated_at DESC,id DESC LIMIT 1`, [libId],
    );
    expect([first.id, second.id]).toContain(Number(current[0].id));
    expect(Number((await ds.query(
      `SELECT count(*)::int AS n FROM hist WHERE entity='vers' AND action='book_swap' AND ref_id=ANY($1::bigint[])`,
      [[first.id, second.id]],
    ))[0].n)).toBe(2);
  });

  it('총쪽수 축소와 진도 상승이 동시에 와도 pages가 기존 progress 아래로 끝나지 않는다', async () => {
    const libId = await lib(100);
    const [student] = await ds.query(`INSERT INTO stu (name) VALUES ('동시성 학생') RETURNING id`);
    const studentId = Number(student.id); madeStudents.push(studentId);
    const issue = await svc.createIssue(owner, { libId, studentId, state: 'ok', progressPage: 0 });

    const settled = await Promise.allSettled([
      svc.patchBook(owner, libId, { pages: 50 }),
      svc.updateIssueProgress(owner, issue.id, 80),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [stored] = await ds.query(
      `SELECT l.pages,i.progress_page FROM lib l JOIN issue i ON i.lib_id=l.id WHERE i.id=$1`, [issue.id],
    );
    expect(Number(stored.pages)).toBeGreaterThanOrEqual(Number(stored.progress_page));
  });

  it('같은 문맥 배정 requestKey의 동시 요청은 ISSUE와 요청 원장을 한 건으로 수렴한다', async () => {
    const suffix = `${Date.now().toString(36)}${serial++}`;
    const kindKey = `bc${suffix}`.slice(0, 16);
    const subKey = `book-${suffix}`.slice(0, 20);
    madeKinds.push(kindKey); madeSubs.push(subKey);
    await ds.query(`INSERT INTO kind(key,name,color,cap,grp,rep) VALUES($1,'동시 배정','#334455',4,'lesson',true)`, [kindKey]);
    await ds.query(`INSERT INTO sub(key,name,color) VALUES($1,'동시 과목','#556677')`, [subKey]);
    const [student] = await ds.query(`INSERT INTO stu(name,grade) VALUES('동시 배정 학생','G9') RETURNING id`);
    const studentId = Number(student.id); madeStudents.push(studentId);
    const [book] = await ds.query(
      `INSERT INTO lib(code,title,sub_key,pages,grade_from,grade_to) VALUES($1,'동시 배정 교재',$2,100,9,12) RETURNING id`,
      [`ASSIGN-${suffix}`, subKey],
    );
    const libId = Number(book.id); madeLibs.push(libId);
    const [version] = await ds.query(`INSERT INTO vers(lib_id,edition,from_date) VALUES($1,'v1',current_date) RETURNING id`, [libId]);
    const [series] = await ds.query(
      `INSERT INTO ser(kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,title)
       VALUES($1,$2,$3,'offline',600,660,'WEEKLY:MO',current_date,'동시 배정 수업') RETURNING id`,
      [kindKey, subKey, owner],
    );
    const serId = Number(series.id); madeSeries.push(serId);
    await ds.query(`INSERT INTO ser_stu(ser_id,student_id,from_date) VALUES($1,$2,current_date)`, [serId, studentId]);

    const command = {
      libId, versId: Number(version.id), studentId, teacherId: owner, subKey, requestKey: randomUUID(),
    };
    const results = await Promise.all([
      new BooksService(ds.getRepository(Lead)).createAssignment(owner, command),
      new BooksService(ds.getRepository(Lead)).createAssignment(owner, command),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(results[0]).toMatchObject({ state: 'wait', version: 1, teacherId: owner, subKey });
    expect(Number((await ds.query(`SELECT count(*)::int AS n FROM issue WHERE student_id=$1 AND lib_id=$2`, [studentId, libId]))[0].n)).toBe(1);
    expect(Number((await ds.query(`SELECT count(*)::int AS n FROM issue_write_req WHERE issue_id=$1`, [results[0].id]))[0].n)).toBe(1);
  });
});
