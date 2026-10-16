/** @file-guide
 * 목적: BO-1014-STAFF 강사 프로필의 생년월일·영어 전용 가능 여부·가능 수업 유형·학력 요약 저장.
 * 책임/재사용: KIND 수업 유형만 연결하며 SUBJECT 과목 모델은 변경하지 않는다. 배포 전 DBML·계약 대조가 필요하다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class StaffTeachingProfile1769600000000 implements MigrationInterface {
  name = 'StaffTeachingProfile1769600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE staff ADD COLUMN birth_on date, ADD COLUMN english_only boolean`);
    await q.query(`CREATE TABLE staff_teaching_kind (
      staff_id bigint NOT NULL,
      kind_key varchar(16) NOT NULL,
      CONSTRAINT staff_teaching_kind_pk PRIMARY KEY(staff_id,kind_key),
      CONSTRAINT staff_teaching_kind_staff_fk FOREIGN KEY(staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      CONSTRAINT staff_teaching_kind_kind_fk FOREIGN KEY(kind_key) REFERENCES kind(key) ON DELETE RESTRICT,
      CONSTRAINT staff_teaching_kind_allowed CHECK(kind_key IN ('class','mock','study'))
    )`);
    await q.query(`CREATE INDEX staff_teaching_kind_kind_idx ON staff_teaching_kind(kind_key)`);
    await q.query(`CREATE TABLE staff_education_summary (
      staff_id bigint NOT NULL,
      position smallint NOT NULL,
      school varchar(120) NOT NULL,
      major varchar(120),
      degree varchar(40),
      status varchar(40),
      CONSTRAINT staff_education_summary_pk PRIMARY KEY(staff_id,position),
      CONSTRAINT staff_education_summary_staff_fk FOREIGN KEY(staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      CONSTRAINT staff_education_summary_position CHECK(position BETWEEN 0 AND 4),
      CONSTRAINT staff_education_summary_school CHECK(char_length(btrim(school)) > 0)
    )`);
  }

  async down(q: QueryRunner): Promise<void> {
    // 검수 뒤 DROP 전 새 입력이 들어오는 틈을 막는다. migration runner의 트랜잭션이 끝날 때까지 쓰기를 잠근다.
    await q.query('LOCK TABLE staff, staff_teaching_kind, staff_education_summary IN SHARE ROW EXCLUSIVE MODE');
    // 생년월일·가능 수업·학력은 재구성할 수 없는 사용자 입력이다. 남아 있으면 DDL 전에 되돌리기를 거절한다.
    const [row] = (await q.query(`SELECT
      EXISTS(SELECT 1 FROM staff WHERE birth_on IS NOT NULL OR english_only IS NOT NULL)
      OR EXISTS(SELECT 1 FROM staff_teaching_kind)
      OR EXISTS(SELECT 1 FROM staff_education_summary) AS has_data`)) as Array<{ has_data: boolean }>;
    if (row.has_data) {
      throw new Error('강사 프로필 데이터가 남아 있어 staff teaching migration을 되돌릴 수 없습니다');
    }
    await q.query(`DROP TABLE IF EXISTS staff_education_summary`);
    await q.query(`DROP TABLE IF EXISTS staff_teaching_kind`);
    await q.query(`ALTER TABLE staff DROP COLUMN IF EXISTS english_only, DROP COLUMN IF EXISTS birth_on`);
  }
}
