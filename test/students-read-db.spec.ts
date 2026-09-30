/** @file-guide
 * 목적: students-read-db.spec.ts — 실제 PostgreSQL의 학생 읽기 SQL/정렬/FK/노출 범위 회귀
 * 책임/재사용: DEV_URL 읽기 전용, StudentsService 실제 쿼리를 실행한다. seed/reset/INSERT/UPDATE/DELETE는 하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource } from 'typeorm';
import { StudentsService } from '../src/modules/students/students.service';
import { DEV_URL } from './db';

const suite = DEV_URL ? describe : describe.skip;
suite('학생 읽기 실제 DB — 변경 없음', () => {
  let ds: DataSource;
  let service: StudentsService;
  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: DEV_URL, synchronize: false, logging: false });
    await ds.initialize();
    service = new StudentsService(ds);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('raw 생성 timestamp/ID 내림차순과10명 페이지를 보존한다', async () => {
    const expected = await ds.query('SELECT id FROM stu ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 20') as { id: string }[];
    expect(expected.length).toBeGreaterThan(0);
    const first = await service.list({});
    const second = await service.list({ page: 2 });
    expect([...first.items, ...second.items].map(row => row.id)).toEqual(expected.map(row => Number(row.id)));
    expect(first.pageSize).toBe(10);
    expect(second.total).toBe(first.total);
  });

  it('학년 정확 일치와 %, 작은따옴표를 literal로 읽으며 빈 페이지 total은 유지한다', async () => {
    const [{ grade }] = await ds.query('SELECT grade FROM stu WHERE grade IS NOT NULL ORDER BY id LIMIT 1') as { grade: string }[];
    const filtered = await service.list({ grade });
    expect(filtered.items.every(row => row.grade === grade)).toBe(true);
    expect(await service.list({ q: "%' OR true --" })).toMatchObject({ items: [], total: 0 });
    const empty = await service.list({ page: 1000000 });
    expect(empty.items).toHaveLength(0);
    expect(empty.total).toBeGreaterThan(0);
  });

  it('모든 현재 학생의 FK 수/직접 학생+연결 상담+보호자 감사만 반환한다', async () => {
    const rows = await ds.query('SELECT id FROM stu ORDER BY id') as { id: string }[];
    for (const { id } of rows) {
      const studentId = Number(id);
      const detail = await service.detail({ id: studentId });
      const [expected] = await ds.query(`SELECT
        (SELECT count(*)::int FROM guardian WHERE student_id=$1) AS guardians,
        (SELECT count(*)::int FROM enr WHERE student_id=$1) AS enrollments,
        (SELECT count(*)::int FROM log WHERE
          (entity='STU' AND entity_id=$1)
          OR (entity='LEAD' AND entity_id IN (SELECT id FROM lead WHERE student_id=$1))
          OR (entity='GUARDIAN' AND entity_id IN (SELECT id FROM guardian WHERE student_id=$1))) AS audits`, [studentId]) as { guardians: number; enrollments: number; audits: number }[];
      expect([detail.guardianTotal, detail.enrollmentTotal, detail.historyTotal]).toEqual([expected.guardians, expected.enrollments, expected.audits]);
      expect(detail.history.length).toBe(Math.min(50, expected.audits));
      for (const audit of detail.history) expect(Object.keys(audit).sort()).toEqual(['action', 'actionLabel', 'actorId', 'actorName', 'at', 'entity', 'entityId', 'id']);
      for (const guardian of detail.guardians) expect(Object.keys(guardian).sort()).toEqual(['active', 'id', 'isPrimary', 'name', 'relation']);
    }
  });

  it('존재하지 않는 안전 정수 ID는404다', async () => {
    const [{ missing }] = await ds.query('SELECT (coalesce(max(id),0)+1)::text AS missing FROM stu') as { missing: string }[];
    await expect(service.detail({ id: Number(missing) })).rejects.toMatchObject({ status: 404 });
  });
});
