/** @file-guide
 * 목적: BOC-13 GPA 퇴역 계약 — 과거 원장 조회 보존과 신규 writer 제거를 검증한다.
 * 책임/재사용: 실제 PostgreSQL projection과 공개 controller/DTO 표면을 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource, Repository } from 'typeorm';
import { GpaCycle } from '../src/entities';
import { GpaController } from '../src/modules/gpa/gpa.controller';
import { GpaService } from '../src/modules/gpa/gpa.service';
import { TEACHER_REQ_HISTORY_TYPES, TEACHER_REQ_TYPES } from '../src/modules/teacher/teacher.dto';
import { dataSourceOptions } from '../src/data-source';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

describe('BOC-13D GPA 공개 계약 퇴역', () => {
  it('GPA controller는 관리자 과거 조회 한 경로만 공개한다', () => {
    expect(Object.getOwnPropertyNames(GpaController.prototype).sort()).toEqual(['board', 'constructor']);
  });

  it('강사 공용 요청 계약에서 gpa_request가 제거됐다', () => {
    expect(TEACHER_REQ_TYPES).toEqual(['wage_change', 'tz_change', 'book_change']);
    expect(TEACHER_REQ_TYPES).not.toContain('gpa_request');
    expect(TEACHER_REQ_HISTORY_TYPES).toContain('gpa_request');
  });
});

d('BOC-13D GPA 과거 원장 projection', () => {
  let ds: DataSource;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('기존 배정·사용·승인 도장은 그대로 읽고 모든 capability와 신규 회차 후보를 닫는다', async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await q.query(`SET LOCAL taco.gpa_archive_restore = 'on'`);
      const [staff] = await q.query(
        `INSERT INTO staff (name,email,login_id,password_hash,role)
         VALUES ('GPA 과거 담당자','boc13-gpa@test.invalid','boc13-gpa-admin','test-hash','admin') RETURNING id`,
      );
      const [student] = await q.query(`INSERT INTO stu (name, grade) VALUES ('GPA 과거 학생','G8') RETURNING id`);
      await q.query(`INSERT INTO gpasvc (key,name,point,sort) VALUES ('boc13','과거 지원',3,901)`);
      const [cycle] = await q.query(
        `INSERT INTO gpa_cycle (no,from_date,to_date,closed,closed_by,closed_at)
         VALUES (1301,'2026-01-01','2026-01-28',true,$1,'2026-01-29T00:00:00Z') RETURNING id`, [staff.id],
      );
      await q.query(
        `INSERT INTO gpa_alloc (cycle_id,student_id,coord_id,points) VALUES ($1,$2,$3,10)`,
        [cycle.id, student.id, staff.id],
      );
      await q.query(
        `INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,start_min,coord_id,state,approved_by,approved_at)
         VALUES ($1,$2,'boc13',3,'2026-01-07',1080,$3,'ok',$3,'2026-01-08T00:00:00Z')`,
        [cycle.id, student.id, staff.id],
      );
      const before = await q.query(
        `SELECT (SELECT count(*) FROM gpa_cycle)::int cycles,
                (SELECT count(*) FROM gpa_alloc)::int allocs,
                (SELECT count(*) FROM gpa_use)::int uses`,
      );
      const repo = { query: (sql: string, params?: unknown[]) => q.query(sql, params) } as unknown as Repository<GpaCycle>;
      const board = await new GpaService(repo).board('2026-01-07');

      expect(board.cycle).toMatchObject({ id: Number(cycle.id), closed: true, canClose: false });
      expect(board.cycle?.closeBlockedReason).toContain('과거 원장만 조회');
      expect(board.students).toEqual([expect.objectContaining({
        studentId: Number(student.id), alloc: 10, used: 3, wait: 0, remain: 7,
      })]);
      expect(board.uses).toEqual([expect.objectContaining({ state: 'ok', points: 3, canApprove: false })]);
      expect(board.lessons).toEqual([]);
      expect(await q.query(
        `SELECT (SELECT count(*) FROM gpa_cycle)::int cycles,
                (SELECT count(*) FROM gpa_alloc)::int allocs,
                (SELECT count(*) FROM gpa_use)::int uses`,
      )).toEqual(before);
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
  });
});
