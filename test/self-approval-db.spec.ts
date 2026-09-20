/** @file-guide
 * 목적: self-approval-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * **올린 사람은 결재하지 못한다** — 결재 갈래 전부에서.
 *
 * 이 회귀가 있는 이유: 2026-09-20 전수 검수에서 같은 규칙이 **일곱 자리 중 셋에만** 있었다.
 * 지출에는 DB CHECK 까지 있는데(`expense_no_self_review` · A-5) 리포트·대표 보고·기획·GPA 넷에는
 * 한 줄도 없었다. **규칙을 정해 놓고 한 곳에만 적용하면 다음 사람도 똑같이 빠뜨린다.**
 *
 * 그래서 여기서는 두 가지를 한다:
 * ① `SELF_APPROVAL_GUARDED` 목록에 있는 이름이 **전부 실제로 막히는지** 확인한다 —
 *    결재 갈래를 새로 만들면서 목록에 한 줄을 더하면 이 회귀가 빠진 방어를 바로 잡는다.
 * ② **DB CHECK** 가 서비스를 우회한 직접 SQL 도 막는지 확인한다. 서비스만 막으면
 *    다음 경로가 생길 때 또 뚫린다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { isSelfReview, SELF_APPROVAL_CODE, SELF_APPROVAL_GUARDED } from '../src/lib/approval';
import { reportReviewIssue } from '../src/lib/rules';
import { assertScratch, blockedBy, TEST_URL } from './db';

describe('isSelfReview — 모르는 것은 막지 않는다', () => {
  it('같은 사람이면 참, 다르면 거짓', () => {
    expect(isSelfReview(7, 7)).toBe(true);
    expect(isSelfReview('7', 7)).toBe(true); // pg 가 bigint 를 문자열로 준다
    expect(isSelfReview(8, 7)).toBe(false);
  });

  it('올린 사람을 모르면(NULL) 막지 않는다 — 옛 행이 그렇다 (N-25)', () => {
    expect(isSelfReview(null, 7)).toBe(false);
    expect(isSelfReview(undefined, 7)).toBe(false);
    expect(isSelfReview('', 7)).toBe(false);
    expect(isSelfReview('nope', 7)).toBe(false);
  });

  it('막는 자리 목록에 여덟이 있다 — 결재 갈래를 늘리면 여기도 는다', () => {
    expect([...SELF_APPROVAL_GUARDED].sort()).toEqual(
      ['chreq', 'expense', 'gpa-use', 'plan', 'plan-due', 'rep', 'req', 'rpt'],
    );
  });
});

describe('리포트 승인 — 쓴 사람은 결재하지 못한다 (순수 규칙)', () => {
  const base = { canApprove: true, state: 'wait' as const, decision: 'approve' as const };

  it('자기가 쓴 리포트면 SELF_APPROVAL_FORBIDDEN', () => {
    expect(reportReviewIssue({ ...base, teacherId: 7, actorId: 7 })).toBe(SELF_APPROVAL_CODE);
  });

  it('남이 쓴 리포트면 통과한다', () => {
    expect(reportReviewIssue({ ...base, teacherId: 8, actorId: 7 })).toBeNull();
  });

  it('강사가 없는 회차(teacherId null)는 막지 않는다', () => {
    expect(reportReviewIssue({ ...base, teacherId: null, actorId: 7 })).toBeNull();
  });

  it('actorId 를 안 주면 그 검사를 건너뛴다 — 화면의 canReview 미리보기 자리', () => {
    expect(reportReviewIssue({ ...base, teacherId: 7 })).toBeNull();
  });

  it('권한이 먼저다 — 자기 리포트여도 권한이 없으면 REPORT_REVIEW_FORBIDDEN', () => {
    expect(reportReviewIssue({ ...base, canApprove: false, teacherId: 7, actorId: 7 }))
      .toBe('REPORT_REVIEW_FORBIDDEN');
  });
});

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

d('DB 가 마지막으로 막는다 — 서비스를 우회한 직접 SQL', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let a = 0;
  let b = 0;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({
      ...dataSourceOptions, url,
      ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
      logging: false,
    });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const made = await q.query(
      `INSERT INTO staff (name, role, email, active, tz) VALUES
         ('자기결재갑','manager','self-a@tnacademy.kr',true,'Asia/Seoul'),
         ('자기결재을','manager','self-b@tnacademy.kr',true,'Asia/Seoul')
       RETURNING id`,
    ) as Array<{ id: string }>;
    a = Number(made[0].id);
    b = Number(made[1].id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    await q?.release();
  });
  afterAll(async () => { await ds?.destroy(); });

  it('rpt — 올린 사람이 결재하면 rpt_no_self_review 가 막고, 남이면 통과한다', async () => {
    const [row] = await q.query(
      `INSERT INTO rpt (rpt_type, on_date, memo, state, sent_at, sent_by)
       VALUES ('day','2026-09-20','{}'::jsonb,'sent', now(), $1) RETURNING id`, [a],
    ) as Array<{ id: string }>;
    expect(await blockedBy(q,
      `UPDATE rpt SET state='ok', reviewed_at=now(), reviewed_by=$2 WHERE id=$1`, [row.id, a],
    )).toMatch(/rpt_no_self_review/);
    await expect(q.query(
      `UPDATE rpt SET state='ok', reviewed_at=now(), reviewed_by=$2 WHERE id=$1`, [row.id, b],
    )).resolves.toBeDefined();
  });

  it('plan — 담당이 자기 기한을 승인하면 plan_due_no_self_approve 가 막는다', async () => {
    const [row] = await q.query(
      `INSERT INTO plan (title, stage, owner_id, due_on) VALUES ('자기결재 기획','draft',$1,'2026-10-01') RETURNING id`,
      [a],
    ) as Array<{ id: string }>;
    expect(await blockedBy(q,
      `UPDATE plan SET due_approved_at=now(), due_approved_by=$2 WHERE id=$1`, [row.id, a],
    )).toMatch(/plan_due_no_self_approve/);
    await expect(q.query(
      `UPDATE plan SET due_approved_at=now(), due_approved_by=$2 WHERE id=$1`, [row.id, b],
    )).resolves.toBeDefined();
  });

  it('올린 사람을 모르는 옛 행은 막지 않는다 — 기존 행 보정 0 (N-25)', async () => {
    const [row] = await q.query(
      `INSERT INTO rpt (rpt_type, on_date, memo, state)
       VALUES ('day','2026-09-21','{}'::jsonb,'sent') RETURNING id`,
    ) as Array<{ id: string }>;
    // sent_by 가 NULL 이면 누가 올렸는지 아무도 모른다 — 같다고도 다르다고도 하지 않는다
    await expect(q.query(
      `UPDATE rpt SET state='ok', reviewed_at=now(), reviewed_by=$2 WHERE id=$1`, [row.id, a],
    )).resolves.toBeDefined();
  });
});
