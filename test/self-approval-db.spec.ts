/** @file-guide
 * 목적: self-approval-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * **올린 사람은 결재하지 못한다** — 결재 갈래 전부에서.
 *
 * 이 회귀가 생긴 이유: 2026-09-20 전수 검수에서 같은 규칙이 **일곱 자리 중 셋에만** 있었다.
 * 지출에는 DB CHECK 까지 있는데(`expense_no_self_review` · A-5) 리포트·대표 보고·기획·GPA 넷에는
 * 한 줄도 없었다. **규칙을 정해 놓고 한 곳에만 적용하면 다음 사람도 똑같이 빠뜨린다.**
 *
 * **대표 결정 2026-09-21 「우선은 매니저에게도 모든 권한」으로 S1 의 넷을 열었다** —
 * 리포트 · 대표 보고 · 기획 기한 · 기획 최종 · GPA. 남은 것은 지출(A-5)과 요청·변경요청 셋이고,
 * 그 셋은 S1 이 만든 것이 아니라 처음부터 있던 규칙이다.
 *
 * 그래서 이 회귀의 일이 하나 바뀌었다 — **목록이 곧 판정임을 지킨다.**
 * ① `SELF_APPROVAL_GUARDED` 에 **있는 것은 막히고 없는 것은 안 막힌다**를 같은 입력으로 나란히 본다.
 *    한동안 이 목록은 여덟을 선언해 두고 판정에는 안 쓰이는 **장식**이었다(이 회귀가 순회만 했다).
 *    이제 `blocksSelfApproval` 이 목록을 실제로 읽으므로, 배열에 이름을 도로 넣으면 그 자리가 다시 막힌다.
 * ② **DB CHECK 와 코드가 같은 말을 하는지** 확인한다 — 연 자리는 직접 SQL 도 통과해야 하고
 *    (CHECK 를 남겨 두면 단추는 서는데 DB 가 거절한다 · S5), 남긴 자리는 여전히 막혀야 한다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import {
  blocksSelfApproval, isSelfReview, SELF_APPROVAL_GUARDED, SELF_APPROVAL_PLACES,
} from '../src/lib/approval';
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

  it('막을 수 있는 자리는 여덟 그대로다 — 연 자리도 목록에서 지우지 않는다', () => {
    expect([...SELF_APPROVAL_PLACES].sort()).toEqual(
      ['chreq', 'expense', 'gpa-use', 'plan', 'plan-due', 'rep', 'req', 'rpt'],
    );
  });

  it('지금 막는 자리는 셋이다 — 대표 결정 2026-09-21 로 S1 의 넷을 열었다', () => {
    expect([...SELF_APPROVAL_GUARDED].sort()).toEqual(['chreq', 'expense', 'req']);
  });

  /**
   * **목록이 곧 판정이다.** 같은 사람·같은 입력을 여덟 자리에 똑같이 넣어 보고,
   * 목록에 있는 것만 막히는지 본다 — 목록과 판정이 갈리면 여기가 빨개진다.
   */
  it('같은 입력을 여덟 자리에 넣으면 목록에 있는 셋만 막는다', () => {
    const blocked = SELF_APPROVAL_PLACES.filter((kind) => blocksSelfApproval(kind, 7, 7));
    expect([...blocked].sort()).toEqual(['chreq', 'expense', 'req']);
    // 남이면 어느 자리도 막지 않는다
    expect(SELF_APPROVAL_PLACES.filter((kind) => blocksSelfApproval(kind, 8, 7))).toEqual([]);
  });
});

describe('리포트 승인 — 쓴 사람은 결재하지 못한다 (순수 규칙)', () => {
  const base = { canApprove: true, state: 'wait' as const, decision: 'approve' as const };

  it('자기가 쓴 리포트도 이제 통과한다 — `rep` 이 목록에서 빠졌다 (대표 결정 2026-09-21)', () => {
    expect(reportReviewIssue({ ...base, teacherId: 7, actorId: 7 })).toBeNull();
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

  /**
   * **연 자리는 DB 도 함께 열려 있어야 한다** (마이그레이션 54).
   * CHECK 를 남겨 두면 서비스는 통과시키는데 DB 가 마지막에 거절한다 — S5 가 아홉 자리에서
   * 고친 그 모양이다. 그래서 여기서는 **막히는지가 아니라 통과하는지**를 본다.
   */
  it('rpt — 올린 사람이 결재해도 이제 통과한다 (마이그레이션 54 로 CHECK 를 내렸다)', async () => {
    const [row] = await q.query(
      `INSERT INTO rpt (rpt_type, on_date, memo, state, sent_at, sent_by)
       VALUES ('day','2026-11-03','{}'::jsonb,'sent', now(), $1) RETURNING id`, [a],
    ) as Array<{ id: string }>;
    await expect(q.query(
      `UPDATE rpt SET state='ok', reviewed_at=now(), reviewed_by=$2 WHERE id=$1`, [row.id, a],
    )).resolves.toBeDefined();
  });

  it('plan — 담당이 자기 기한을 승인해도 이제 통과한다', async () => {
    const [row] = await q.query(
      `INSERT INTO plan (title, stage, owner_id, due_on) VALUES ('자기결재 기획','draft',$1,'2026-10-01') RETURNING id`,
      [a],
    ) as Array<{ id: string }>;
    await expect(q.query(
      `UPDATE plan SET due_approved_at=now(), due_approved_by=$2 WHERE id=$1`, [row.id, a],
    )).resolves.toBeDefined();
  });

  /**
   * **남긴 셋은 표도 그대로다.** 지출은 이번 결정의 범위 밖이라(A-5 · 처음부터 있던 규칙)
   * 코드(`SELF_APPROVAL_GUARDED` 의 `expense`)와 표가 **여전히 같은 말**을 한다.
   * 이 줄이 빨개지면 둘 중 하나만 움직인 것이다.
   */
  it('expense — 자기 신청을 자기가 심사하면 표가 막는다 (A-5 · 이번 결정의 범위 밖)', async () => {
    const [row] = await q.query(
      `INSERT INTO expense (spend_on, category, purpose, requested_amount, state, requester_id)
       VALUES ('2026-09-20', 'etc', '자기심사 표본', 10000, 'pending', $1) RETURNING id`, [a],
    ) as Array<{ id: string }>;
    expect(await blockedBy(q,
      `UPDATE expense SET state='approved', reviewer_id=$2 WHERE id=$1`, [row.id, a],
    )).toMatch(/expense_no_self_review/);
    await expect(q.query(
      `UPDATE expense SET state='approved', reviewer_id=$2 WHERE id=$1`, [row.id, b],
    )).resolves.toBeDefined();
  });

  it('올린 사람을 모르는 옛 행은 막지 않는다 — 기존 행 보정 0 (N-25 · 지출에 남은 규약)', async () => {
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
