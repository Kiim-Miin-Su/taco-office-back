/** @file-guide
 * 목적: 10/14 PPTX p8 결정(2026-10-16) — 강사 가능 과목을 실제 과목(SUB) 단위로 저장하는 staff_teaching_subject.
 * 책임/재사용: 수업·모의수업·자습(KIND class/mock/study) 과목만 연결한다(GPA·상담·회의 제외). migration 127의 staff_teaching_kind 행은
 *   과목으로 추정 변환하지 않고 그대로 둔다(N-25) — 읽기 전용 이전 입력이다. 배포 전 DBML·계약 대조가 필요하다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class StaffTeachingSubject1769800000000 implements MigrationInterface {
  name = 'StaffTeachingSubject1769800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE staff_teaching_subject (
      staff_id bigint NOT NULL,
      sub_key varchar(20) NOT NULL,
      CONSTRAINT staff_teaching_subject_pk PRIMARY KEY(staff_id,sub_key),
      CONSTRAINT staff_teaching_subject_staff_fk FOREIGN KEY(staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      CONSTRAINT staff_teaching_subject_sub_fk FOREIGN KEY(sub_key) REFERENCES sub(key) ON DELETE RESTRICT
    )`);
    await q.query(`CREATE INDEX staff_teaching_subject_sub_idx ON staff_teaching_subject(sub_key)`);
    /*
     * 과목의 종류는 다른 표(sub.kind_key)에 있어 CHECK로 못 건다 — 넣고 바꾸는 순간 트리거가 본다.
     * 서버(drawer.service)가 먼저 400 STAFF_TEACHING_SUBJECT로 막고, 이 트리거는 직접 SQL까지 막는 마지막 방어다.
     * 이미 연결된 과목의 종류가 나중에 바뀌는 경우는 잡지 않는다 — 그 연결은 그때의 사실로 읽는다.
     */
    await q.query(`CREATE FUNCTION staff_teaching_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM sub s WHERE s.key = NEW.sub_key AND s.kind_key IN ('class','mock','study')) THEN
          RAISE EXCEPTION 'STAFF_TEACHING_SUBJECT_KIND' USING ERRCODE='23514', CONSTRAINT='staff_teaching_subject_kind';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER staff_teaching_subject_guard BEFORE INSERT OR UPDATE ON staff_teaching_subject
      FOR EACH ROW EXECUTE FUNCTION staff_teaching_subject_guard()`);
  }

  async down(q: QueryRunner): Promise<void> {
    // 검사와 DROP 사이에 새 과목 선택이 끼어들지 않게 트랜잭션 끝까지 쓰기를 잠근다(127과 같은 순서).
    await q.query('LOCK TABLE staff, staff_teaching_subject IN SHARE ROW EXCLUSIVE MODE');
    // 가능 과목은 재구성할 수 없는 사용자 입력이다. 남아 있으면 DDL 전에 되돌리기를 거절한다.
    const [row] = (await q.query(`SELECT EXISTS(SELECT 1 FROM staff_teaching_subject) AS has_data`)) as Array<{ has_data: boolean }>;
    if (row.has_data) {
      throw new Error('강사 가능 과목 데이터가 남아 있어 staff teaching subject migration을 되돌릴 수 없습니다');
    }
    await q.query(`DROP TRIGGER IF EXISTS staff_teaching_subject_guard ON staff_teaching_subject`);
    await q.query(`DROP TABLE IF EXISTS staff_teaching_subject`);
    await q.query(`DROP FUNCTION IF EXISTS staff_teaching_subject_guard()`);
  }
}
