/** @file-guide
 * 목적: 1758600000000-chreq-reject-reason.ts — ChreqRejectReason1758600000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CHREQ 에 **반려 사유 칸**을 만든다 (D-R13 · C42).
 *
 * 지금까지 `CHREQ.reason` 하나가 **신청 사유와 반려 사유를 같이** 쓰고 있었다.
 * 서랍 코드에도 그 흔적이 남아 있다 — 「변경 요청은 반려 사유와 신청 사유가 같은 컬럼이라,
 * 되돌아온 것일 때만 사유로 읽는다」. 그래서 반려하는 순간 **올린 사람이 적은 말이 지워진다.**
 * 「왜 올렸는지」와 「왜 안 됐는지」는 둘 다 남아야 하는 사실이다.
 *
 * REQ 표는 처음부터 두 칸을 따로 갖고 있었다(`reason` 은 payload 안, `reject_reason` 은 컬럼) —
 * 두 표의 모양을 맞춘다.
 *
 * 기존 행은 **건드리지 않는다.** 이미 반려된 건의 `reason` 이 신청 사유인지 반려 사유인지
 * 알 방법이 없고, 추정해서 옮기면 원장이 거짓이 된다 (추정 이관 금지).
 */
export class ChreqRejectReason1758600000000 implements MigrationInterface {
  name = 'ChreqRejectReason1758600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE chreq ADD COLUMN IF NOT EXISTS reject_reason text`);
    await q.query(
      `COMMENT ON COLUMN chreq.reject_reason IS '반려 사유 — 반려 시 필수 (D-R13). 신청 사유(reason)를 덮어쓰지 않는다'`,
    );
    // 반려면 사유가 있어야 한다 — 규칙을 표가 거부하게 한다.
    // 이 컬럼이 없던 동안 반려된 행은 NULL 이므로 **기존 행은 검사하지 않는다**(NOT VALID).
    await q.query(
      `ALTER TABLE chreq ADD CONSTRAINT chreq_reject_needs_reason
         CHECK (state <> 'rejected' OR reject_reason IS NOT NULL) NOT VALID`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE chreq DROP CONSTRAINT IF EXISTS chreq_reject_needs_reason`);
    await q.query(`ALTER TABLE chreq DROP COLUMN IF EXISTS reject_reason`);
  }
}
