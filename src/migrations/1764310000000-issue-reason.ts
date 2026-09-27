/** @file-guide
 * 목적: 1764310000000-issue-reason.ts — IssueReason1764310000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 배부 사유 `issue.reason` — **무슨 교재를 왜 줬는지** 남는 칸 (N-62 ① 채택 · W11 · 원문 슬라이드 37
 * 「교재 투명성이 TN아카데미 차별점 — 무슨 교재를 왜 줬는지 남습니다」).
 *
 * - text · NULL 허용 — 옛 배부 줄은 NULL 그대로다(사유를 지어 넣지 않는다 · 보정 0).
 * - 진단 점수는 여기 적지 않는다 — 배부 창이 그 학생의 최신 상담 진단(`lead_diag`)을 **보여 주기만** 한다(D-R22 · DQ1).
 *
 * `down` 은 칸을 지운다 — 그 사이 적힌 사유도 함께 사라진다.
 */
export class IssueReason1764310000000 implements MigrationInterface {
  name = 'IssueReason1764310000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issue" ADD COLUMN "reason" text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issue" DROP COLUMN IF EXISTS "reason"`);
  }
}
