/** @file-guide
 * 목적: 강사 교체 apply의 멱등 receipt와 전체 실행 취소 payload를 영속화한다.
 * 책임/재사용: 일정 자체는 기존 SER/EXC와 서명 undo token이 소유하고, 이 표는 여러 일정 쓰기와 GUIDE/PNOTI/ISSUE/CPL을 한 작업으로 묶는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TeacherChangeOperation1768800000000 implements MigrationInterface {
  name = 'TeacherChangeOperation1768800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE teacher_change_operation (
        request_key uuid PRIMARY KEY,
        actor_id bigint NOT NULL REFERENCES staff(id),
        command_fingerprint char(64) NOT NULL,
        expected_version char(64) NOT NULL,
        state varchar(12) NOT NULL DEFAULT 'applied',
        row_version integer NOT NULL DEFAULT 1,
        result jsonb NOT NULL,
        undo_payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        undone_by bigint REFERENCES staff(id),
        undone_at timestamptz,
        CONSTRAINT teacher_change_operation_state_chk CHECK (state IN ('applied','undone')),
        CONSTRAINT teacher_change_operation_version_chk CHECK (row_version >= 1),
        CONSTRAINT teacher_change_operation_undo_shape_chk CHECK (
          (state='applied' AND row_version=1 AND undone_by IS NULL AND undone_at IS NULL)
          OR (state='undone' AND row_version=2 AND undone_by IS NOT NULL AND undone_at IS NOT NULL)
        )
      )
    `);
    await q.query(`CREATE INDEX teacher_change_operation_actor_created_idx ON teacher_change_operation(actor_id,created_at DESC)`);
    await q.query(`COMMENT ON TABLE teacher_change_operation IS 'BO-12C 권고안: requestKey 멱등 receipt와 복합 강사 교체 undo 경계'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE teacher_change_operation`);
  }
}
