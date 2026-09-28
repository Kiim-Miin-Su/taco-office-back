/** @file-guide
 * 목적: 종료된 교재 배부 하나를 동시에 두 번 재배부해도 계보·활성 행이 하나만 남는지 실제 PostgreSQL로 검증한다.
 * 책임/재사용: BooksService 공개 API를 별도 connection에서 동시 호출하고 DB unique 제약과 서비스 오류 계약을 함께 본다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BooksService } from '../src/modules/books/books.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(30_000);

d('교재 재배부 동시성', () => {
  let ds: DataSource;
  let staffId: number;
  let studentId: number;
  let libId: number;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });

  beforeEach(async () => {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    const [staff] = await ds.query(
      `INSERT INTO staff (name,email,role,active) VALUES ('재배부 담당',$1,'admin',true) RETURNING id`,
      [`book-reissue-${suffix}@test.local`],
    );
    const [student] = await ds.query(`INSERT INTO stu (name,grade) VALUES ($1,'G9') RETURNING id`, [`재배부-${suffix}`]);
    const [lib] = await ds.query(`INSERT INTO lib (code,title,pages) VALUES ($1,'동시성 교재',100) RETURNING id`, [`REISSUE-${suffix}`]);
    staffId = Number(staff.id); studentId = Number(student.id); libId = Number(lib.id);
  });

  afterEach(async () => {
    const issueIds = (await ds.query(`SELECT id FROM issue WHERE student_id=$1 AND lib_id=$2`, [studentId, libId]))
      .map((row: { id: string }) => Number(row.id));
    if (issueIds.length) {
      await ds.query(`DELETE FROM hist WHERE entity='issue' AND ref_id=ANY($1::bigint[])`, [issueIds]);
      await ds.query(`DELETE FROM log WHERE entity='ISSUE' AND entity_id=ANY($1::bigint[])`, [issueIds]);
    }
    await ds.query(`DELETE FROM issue WHERE student_id=$1 AND lib_id=$2`, [studentId, libId]);
    await ds.query(`DELETE FROM lib WHERE id=$1`, [libId]);
    await ds.query(`DELETE FROM stu WHERE id=$1`, [studentId]);
    await ds.query(`DELETE FROM staff WHERE id=$1`, [staffId]);
  });

  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('같은 종료 행에 대한 동시 재배부는 한 건만 생성한다', async () => {
    const setup = new BooksService(ds.getRepository(Lead));
    const source = await setup.createIssue(staffId, { studentId, libId, state: 'wait' });
    await setup.transitionIssue(staffId, source.id, 'canceled', '재선정');

    const attempts = await Promise.allSettled([
      new BooksService(ds.getRepository(Lead)).createIssue(staffId, { studentId, libId, state: 'wait', reissuedFrom: source.id }),
      new BooksService(ds.getRepository(Lead)).createIssue(staffId, { studentId, libId, state: 'wait', reissuedFrom: source.id }),
    ]);

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ response: { code: 'BOOK_ALREADY_REISSUED' } });
    expect(await ds.query(
      `SELECT reissued_from FROM issue WHERE student_id=$1 AND lib_id=$2 AND state IN ('wait','auto','ok')`,
      [studentId, libId],
    )).toEqual([{ reissued_from: String(source.id) }]);
  });
});
