import { MigrationInterface, QueryRunner } from 'typeorm';

/** REP 승인/반려 레코드가 DTO·전이 가드와 같은 불변식을 갖게 한다 (D-R13 · D-R34). */
export class ReportReviewContract1757200000000 implements MigrationInterface {
  name = 'ReportReviewContract1757200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM rep
           WHERE (state IN ('wait', 'ok', 'rej') AND (written_at IS NULL OR submitted_at IS NULL))
              OR (state IN ('ok', 'rej') AND (reviewed_at IS NULL OR reviewer_id IS NULL))
              OR (state = 'rej' AND NULLIF(BTRIM(reject_reason), '') IS NULL)
              OR (state = 'ok' AND reject_reason IS NOT NULL)
              OR (state NOT IN ('ok', 'rej')
                  AND (reviewed_at IS NOT NULL OR reviewer_id IS NOT NULL OR reject_reason IS NOT NULL))
        ) THEN
          RAISE EXCEPTION 'REP 승인/반려 계약에 맞지 않는 기존 레코드가 있습니다';
        END IF;
      END $$
    `);
    await q.query(`
      ALTER TABLE rep ADD CONSTRAINT rep_review_contract CHECK (
        (state NOT IN ('wait', 'ok', 'rej') OR (written_at IS NOT NULL AND submitted_at IS NOT NULL))
        AND (
          (state = 'ok' AND reviewed_at IS NOT NULL AND reviewer_id IS NOT NULL AND reject_reason IS NULL)
          OR (state = 'rej' AND reviewed_at IS NOT NULL AND reviewer_id IS NOT NULL
              AND NULLIF(BTRIM(reject_reason), '') IS NOT NULL)
          OR (state NOT IN ('ok', 'rej')
              AND reviewed_at IS NULL AND reviewer_id IS NULL AND reject_reason IS NULL)
        )
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE rep DROP CONSTRAINT rep_review_contract');
  }
}
