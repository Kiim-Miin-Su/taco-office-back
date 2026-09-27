/** @file-guide
 * 목적: C-40 회차 출결에 종속되는 학생별 지각 현재값 테이블을 추가한다.
 * 책임/재사용: ATT의 completed/canceled·정산 판정은 유지하고 지각 사실만 FK·유일성으로 보존한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C-40 학생별 지각 원장.
 *
 * ATT는 회차 전체의 completed/canceled와 정산 판정을 계속 소유한다. 지각은 ATT의
 * 결과를 늘리지 않고, 현재 출결 한 줄에 종속된 학생별 사실만 따로 보관한다.
 */
export class AttendanceStudentLate1765000000000 implements MigrationInterface {
  name = 'AttendanceStudentLate1765000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE att_late (
      id bigserial NOT NULL,
      att_id bigint NOT NULL,
      student_id bigint NOT NULL,
      confirmed_by bigint NOT NULL,
      confirmed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT att_late_att_fk FOREIGN KEY (att_id) REFERENCES att(id) ON DELETE CASCADE,
      CONSTRAINT att_late_student_fk FOREIGN KEY (student_id) REFERENCES stu(id),
      CONSTRAINT att_late_confirmer_fk FOREIGN KEY (confirmed_by) REFERENCES staff(id),
      CONSTRAINT att_late_att_student_uniq UNIQUE (att_id, student_id)
    )`);
    await q.query(`CREATE INDEX att_late_student_at_idx ON att_late (student_id, confirmed_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS att_late_student_at_idx`);
    await q.query(`DROP TABLE IF EXISTS att_late`);
  }
}
