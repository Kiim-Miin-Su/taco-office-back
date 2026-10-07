/** @file-guide
 * 목적: BOC-04E-01 학생 허브 aggregate의 관계 소유권·기간 조회·cursor 경로를 DB 정본으로 고정한다.
 * 책임/재사용: 기존 행을 보존하면서 누락 FK를 검증하고, StudentsService가 실제 사용하는 학생 역방향 조회 인덱스만 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-04-SCENARIOS-2026-10-06.md · docs/contracts/db/erd.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudentHubRelations1766900000000 implements MigrationInterface {
  name = 'StudentHubRelations1766900000000';

  async up(q: QueryRunner): Promise<void> {
    // BOC-04E-01 권고안 채택(2026-10-08): 앱의 exact studentId 조건만 믿지 않고,
    // ENR·REP_STU·INV·LEAD의 학생 소유권을 FK로 고정한다. INV는 enrollment id만 연결하면
    // 다른 학생의 ENR을 잘못 청구할 수 있으므로 (enr_id, student_id)를 함께 참조한다.
    // 변경 시 StudentsService.hub/detail, entity metadata, DBML, 두 수정사항 대조표를 함께 고친다.
    await q.query(`ALTER TABLE enr ADD CONSTRAINT enr_student_identity UNIQUE (id, student_id)`);
    await q.query(`ALTER TABLE enr ADD CONSTRAINT enr_student_fk
      FOREIGN KEY (student_id) REFERENCES stu(id) ON DELETE NO ACTION NOT VALID`);
    await q.query(`ALTER TABLE enr ADD CONSTRAINT enr_kind_fk
      FOREIGN KEY (kind_key) REFERENCES kind(key) ON DELETE NO ACTION NOT VALID`);
    await q.query(`ALTER TABLE enr ADD CONSTRAINT enr_sub_fk
      FOREIGN KEY (sub_key) REFERENCES sub(key) ON DELETE NO ACTION NOT VALID`);
    await q.query(`ALTER TABLE rep_stu ADD CONSTRAINT rep_stu_rep_fk
      FOREIGN KEY (rep_id) REFERENCES rep(id) ON DELETE NO ACTION NOT VALID`);
    await q.query(`ALTER TABLE rep_stu ADD CONSTRAINT rep_stu_student_fk
      FOREIGN KEY (student_id) REFERENCES stu(id) ON DELETE NO ACTION NOT VALID`);
    await q.query(`ALTER TABLE inv ADD CONSTRAINT inv_student_fk
      FOREIGN KEY (student_id) REFERENCES stu(id) ON DELETE NO ACTION NOT VALID`);
    await q.query(`ALTER TABLE inv ADD CONSTRAINT inv_enrollment_student_fk
      FOREIGN KEY (enr_id, student_id) REFERENCES enr(id, student_id) ON DELETE NO ACTION NOT VALID`);
    await q.query(`ALTER TABLE lead ADD CONSTRAINT lead_student_fk
      FOREIGN KEY (student_id) REFERENCES stu(id) ON DELETE NO ACTION NOT VALID`);

    for (const [table, constraint] of [
      ['enr', 'enr_student_fk'],
      ['enr', 'enr_kind_fk'],
      ['enr', 'enr_sub_fk'],
      ['rep_stu', 'rep_stu_rep_fk'],
      ['rep_stu', 'rep_stu_student_fk'],
      ['inv', 'inv_student_fk'],
      ['inv', 'inv_enrollment_student_fk'],
      ['inv', 'inv_cs_fk'],
      ['lead', 'lead_student_fk'],
    ] as const) {
      await q.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`);
    }

    // 목록·count·keyset은 모두 student_id가 선두여야 한다. 이름은 query owner와 목적을 드러내
    // EXPLAIN/운영 진단에서 문서의 기능 경로를 바로 찾을 수 있게 한다.
    await q.query(`CREATE INDEX enr_student_hub_idx ON enr(student_id, started_on DESC, id DESC)`);
    await q.query(`CREATE INDEX ser_stu_student_period_idx ON ser_stu(student_id, from_date, to_date, ser_id)`);
    await q.query(`CREATE INDEX rep_stu_student_report_idx ON rep_stu(student_id, rep_id)`);
    await q.query(`CREATE INDEX cons_stu_student_cons_idx ON cons_stu(student_id, cons_id)`);
    await q.query(`CREATE INDEX guide_student_state_idx ON guide(student_id, state, id DESC)`);
    await q.query(`CREATE INDEX issue_student_state_idx ON issue(student_id, state, id DESC)`);
    await q.query(`CREATE INDEX inv_student_hub_idx ON inv(student_id, year_month DESC, id DESC)`);
    await q.query(`CREATE INDEX note_student_hub_idx ON note(student_id, created_at DESC, id DESC)`);
    await q.query(`CREATE INDEX lead_student_idx ON lead(student_id, id) WHERE student_id IS NOT NULL`);
    await q.query(`CREATE INDEX stu_profile_period_current_lookup
      ON stu_profile_period(student_id, field, valid_from DESC, valid_to, id DESC)
      WHERE superseded_at IS NULL`);

    // 새 keyset 인덱스가 기존 prefix까지 포함하므로 중복 쓰기 비용을 제거한다.
    await q.query(`DROP INDEX inv_student_id_year_month_idx`);
    await q.query(`DROP INDEX note_student_id_created_at_idx`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX inv_student_id_year_month_idx ON inv(student_id, year_month)`);
    await q.query(`CREATE INDEX note_student_id_created_at_idx ON note(student_id, created_at)`);

    await q.query(`DROP INDEX stu_profile_period_current_lookup`);
    await q.query(`DROP INDEX lead_student_idx`);
    await q.query(`DROP INDEX note_student_hub_idx`);
    await q.query(`DROP INDEX inv_student_hub_idx`);
    await q.query(`DROP INDEX issue_student_state_idx`);
    await q.query(`DROP INDEX guide_student_state_idx`);
    await q.query(`DROP INDEX cons_stu_student_cons_idx`);
    await q.query(`DROP INDEX rep_stu_student_report_idx`);
    await q.query(`DROP INDEX ser_stu_student_period_idx`);
    await q.query(`DROP INDEX enr_student_hub_idx`);

    await q.query(`ALTER TABLE lead DROP CONSTRAINT lead_student_fk`);
    await q.query(`ALTER TABLE inv DROP CONSTRAINT inv_enrollment_student_fk`);
    await q.query(`ALTER TABLE inv DROP CONSTRAINT inv_student_fk`);
    await q.query(`ALTER TABLE rep_stu DROP CONSTRAINT rep_stu_student_fk`);
    await q.query(`ALTER TABLE rep_stu DROP CONSTRAINT rep_stu_rep_fk`);
    await q.query(`ALTER TABLE enr DROP CONSTRAINT enr_sub_fk`);
    await q.query(`ALTER TABLE enr DROP CONSTRAINT enr_kind_fk`);
    await q.query(`ALTER TABLE enr DROP CONSTRAINT enr_student_fk`);
    await q.query(`ALTER TABLE enr DROP CONSTRAINT enr_student_identity`);

    // 직전 스키마의 검증 상태까지 복원한다.
    await q.query(`ALTER TABLE inv DROP CONSTRAINT inv_cs_fk`);
    await q.query(`ALTER TABLE inv ADD CONSTRAINT inv_cs_fk
      FOREIGN KEY (cs_id) REFERENCES cons(id) ON DELETE NO ACTION NOT VALID`);
  }
}
