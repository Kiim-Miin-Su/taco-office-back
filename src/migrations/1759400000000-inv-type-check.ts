/** @file-guide
 * 목적: 1759400000000-inv-type-check.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `inv.inv_type` 을 **넷으로 굳힌다** (대표 결정 2026-09-13 · N-37).
 *
 * C50 이 「낱말을 굳히는 것도 목록이 확정된 뒤다」라고 적고 CHECK 를 안 걸어 두었다.
 * §57 컷의 「그 밖의 수입」 세 줄 + 수업료로 목록이 확정됐으므로 이제 건다.
 *
 * **NOT VALID 로 건다.** 지금 있는 행은 전부 `tuition`·`consulting` 이라 통과하겠지만,
 * 검사형 제약을 기존 행에 강제로 들이대는 방식은 이 저장소가 쓰지 않는다 —
 * 운영 DB 에 우리가 모르는 값이 있으면 그 자리에서 마이그레이션이 멈추고,
 * 멈추는 것보다 **어디에 무엇이 있는지 먼저 보는 것**이 맞다.
 * `migration:dryrun` 이 위반 행 수를 세어 준다.
 *
 * 기존 행은 **한 줄도 고치지 않는다** (N-25 — 추정 이관 금지).
 */
export class InvTypeCheck1759400000000 implements MigrationInterface {
  name = 'InvTypeCheck1759400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "inv" ADD CONSTRAINT "inv_type_check"
        CHECK ("inv_type" IN ('tuition', 'consulting', 'diag_intake', 'exam_fee')) NOT VALID
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "inv" DROP CONSTRAINT IF EXISTS "inv_type_check"`);
  }
}
