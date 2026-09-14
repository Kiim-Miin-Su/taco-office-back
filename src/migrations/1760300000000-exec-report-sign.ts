/** @file-guide
 * 목적: 대표 보고의 서명 — 누가 올렸고 누가 결재했는지를 RPT 에 남긴다.
 * 책임/재사용: 기존 행을 보정하지 않고 칸과 제약만 더한다. 전이 판정은 서비스가, 짝 보장은 여기가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C85-a — 원본 §69 아래에 **서명줄 두 칸**이 있다: 「올린 사람 —」 · 「대표 승인 —」.
 *
 * RPT 는 `sent_at`·`reviewed_at` 으로 **언제**는 적어 두었는데 **누가**를 적을 칸이 없었다.
 * 시각만 있는 서명은 서명이 아니다 — 대표가 나중에 「이건 누가 올린 거냐」를 물을 수 없다.
 *
 * `ON DELETE RESTRICT` 인 이유: 서명한 사람을 지우면 **서명이 조용히 사라진다.** 사람을
 * 그만 쓰는 길은 `STAFF.active=false` 이고, 그 길은 서명을 지우지 않는다.
 *
 * CHECK 는 **짝**을 지킨다 — 시각이 있으면 사람이 있고, 사람이 있으면 시각이 있다
 * (C43-b 의 `payout_confirm_pair` 와 같은 모양). `NOT VALID` 로 걸어 **기존 행은 보정하지
 * 않는다** (N-25) — 시드의 옛 보고는 `sent_at` 만 갖고 있고, 누가 올렸는지는 **아무도 모른다.**
 * 모르는 것을 지어내지 않는다.
 */
export class ExecReportSign1760300000000 implements MigrationInterface {
  name = 'ExecReportSign1760300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE rpt ADD COLUMN sent_by bigint REFERENCES staff(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE rpt ADD COLUMN reviewed_by bigint REFERENCES staff(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE rpt ADD CONSTRAINT rpt_sign_pair CHECK (
      (sent_at IS NULL) = (sent_by IS NULL)
      AND (reviewed_at IS NULL) = (reviewed_by IS NULL)
    ) NOT VALID`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE rpt DROP CONSTRAINT IF EXISTS rpt_sign_pair`);
    await q.query(`ALTER TABLE rpt DROP COLUMN IF EXISTS reviewed_by`);
    await q.query(`ALTER TABLE rpt DROP COLUMN IF EXISTS sent_by`);
  }
}
