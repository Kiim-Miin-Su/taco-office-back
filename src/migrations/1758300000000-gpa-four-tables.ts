/** @file-guide
 * 목적: gpa-four-tables.ts (migration)
 * 책임/재사용: 변경 당시 SQL을 고정하고 기존 행을 자동 보정/삭제하지 않는다. preflight·up/down·실제 DB 검증과 운영 적용을 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N-13 채택 (2026-09-12 §4-17 ①) · 구 M2: GPA 4표 — erd.dbml 의 「표로 뺀다」 안 그대로.
 * 사이클이 1급 객체라 「배정 − 사용 − 대기 = 잔여」와 「이월 없이 소멸」이 스캔 없이 계산된다.
 * points 는 GPASVC.point 의 스냅샷 — 규정이 바뀌어도 과거 소비는 그대로다.
 */
export class GpaFourTables1758300000000 implements MigrationInterface {
  name = 'GpaFourTables1758300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE gpasvc (
      key   varchar(8)  PRIMARY KEY,
      name  varchar(30) NOT NULL,
      point smallint    NOT NULL,
      color char(7),
      sort  smallint,
      CONSTRAINT gpasvc_point_check CHECK (point > 0)
    )`);
    await q.query(`CREATE TABLE gpa_cycle (
      id        bigserial PRIMARY KEY,
      no        smallint  NOT NULL,
      from_date date      NOT NULL,
      to_date   date      NOT NULL,
      closed    boolean   NOT NULL DEFAULT false,
      CONSTRAINT gpa_cycle_range_check CHECK (from_date < to_date)
    )`);
    await q.query(`CREATE INDEX gpa_cycle_window ON gpa_cycle (from_date, to_date)`);
    await q.query(`CREATE TABLE gpa_alloc (
      id         bigserial PRIMARY KEY,
      cycle_id   bigint   NOT NULL REFERENCES gpa_cycle(id),
      student_id bigint   NOT NULL REFERENCES stu(id),
      coord_id   bigint   REFERENCES staff(id),
      points     smallint NOT NULL,
      CONSTRAINT gpa_alloc_points_check CHECK (points >= 0)
    )`);
    await q.query(`CREATE UNIQUE INDEX gpa_alloc_cycle_student ON gpa_alloc (cycle_id, student_id)`);
    await q.query(`CREATE TABLE gpa_use (
      id         bigserial   PRIMARY KEY,
      cycle_id   bigint      NOT NULL REFERENCES gpa_cycle(id),
      student_id bigint      NOT NULL REFERENCES stu(id),
      ser_id     bigint      REFERENCES ser(id),
      svc_key    varchar(8)  NOT NULL REFERENCES gpasvc(key),
      points     smallint    NOT NULL,
      on_date    date        NOT NULL,
      start_min  smallint,
      coord_id   bigint      REFERENCES staff(id),
      note_url   text,
      state      varchar(8)  NOT NULL DEFAULT 'wait',
      CONSTRAINT gpa_use_points_check CHECK (points > 0),
      CONSTRAINT gpa_use_state_check CHECK (state IN ('wait','ok')),
      CONSTRAINT gpa_use_start_check CHECK (start_min IS NULL OR start_min BETWEEN 0 AND 1439)
    )`);
    await q.query(`CREATE INDEX gpa_use_cycle_student_date ON gpa_use (cycle_id, student_id, on_date)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE gpa_use`);
    await q.query(`DROP TABLE gpa_alloc`);
    await q.query(`DROP TABLE gpa_cycle`);
    await q.query(`DROP TABLE gpasvc`);
  }
}
