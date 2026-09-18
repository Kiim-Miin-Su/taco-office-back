import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EXC 에 휴강의 **사유와 처리**를 새긴다 — C92 (테스트 시나리오 C-30 ~ C-34).
 *
 * 지금까지 휴강은 `canceled = true` 한 비트였다. 그래서 청구 계산(`invoice-lines.ts`)이
 * 「안 한 수업」을 전부 같은 것으로 읽었고, **학생 결석의 차감**과 **학원 사정의 이월**을
 * 가를 수 없었다. 이 학원의 기본 정책은 이월이고, 차감은 학생 쪽 사정에만 허용되며,
 * 보강을 잡으면 원래 회차는 세지 않는다 — 그 셋을 `cancel_treat` 로 저장한다.
 *
 * **기존 행은 보정하지 않는다** (N-25). 옛 휴강의 사유와 처리는 아무도 모른다 —
 * NULL 로 두고 청구 계산이 **기본 정책(이월)** 으로 읽는다. CHECK 는 새 행만 검사한다.
 */
export class CancelPolicy1760500000000 implements MigrationInterface {
  name = 'CancelPolicy1760500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE exc ADD COLUMN IF NOT EXISTS cancel_kind varchar(16)`);
    await q.query(`ALTER TABLE exc ADD COLUMN IF NOT EXISTS cancel_treat varchar(8)`);
    await q.query(
      `ALTER TABLE exc ADD CONSTRAINT exc_cancel_policy CHECK (
         (cancel_kind IS NULL OR cancel_kind IN ('teacher_absent','student_absent','academy','holiday','other'))
         AND (cancel_treat IS NULL OR cancel_treat IN ('carry','deduct','makeup'))
         AND (cancel_treat IS NULL OR (canceled AND cancel_kind IS NOT NULL))
         AND (cancel_treat IS DISTINCT FROM 'deduct' OR cancel_kind = 'student_absent')
       ) NOT VALID`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE exc DROP CONSTRAINT IF EXISTS exc_cancel_policy`);
    await q.query(`ALTER TABLE exc DROP COLUMN IF EXISTS cancel_treat`);
    await q.query(`ALTER TABLE exc DROP COLUMN IF EXISTS cancel_kind`);
  }
}
