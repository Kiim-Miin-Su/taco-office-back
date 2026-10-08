/** @file-guide
 * 목적: BOC-08D-01 리포트별 교재 진도·숙제 원장과 직접 쓰기 방어를 추가한다.
 * 책임/재사용: 과거 REP/ISSUE는 추정 이관하지 않고 formatVersion=1 저장부터 원장을 쌓는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D1-REPORT-BOOK-PROGRESS-2026-10-09.md · docs/contracts/db/erd.dbml
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOC-08D-01 권고안 채택(2026-10-09): 리포트의 교재·쪽 범위 snapshot을 REP 본문에 보존하면서
 * 수업별 조회는 rep_book_progress가 소유하고 ISSUE.progress_page는 완료 진도의 비감소 projection으로 갱신한다.
 * 정책 변경 시 DTO/service/Front/DBML/P-BOC08D01/두 수정사항 대조표/portfolio를 함께 수정한다.
 */
export class ReportBookProgress1767800000000 implements MigrationInterface {
  name = 'ReportBookProgress1767800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE rep_book_progress (
        id bigserial PRIMARY KEY,
        rep_id bigint NOT NULL REFERENCES rep(id) ON DELETE CASCADE,
        issue_id bigint NOT NULL REFERENCES issue(id) ON DELETE RESTRICT,
        lib_id bigint NOT NULL REFERENCES lib(id) ON DELETE RESTRICT,
        vers_id bigint REFERENCES vers(id) ON DELETE RESTRICT,
        student_id bigint NOT NULL REFERENCES stu(id) ON DELETE RESTRICT,
        lesson_on date NOT NULL,
        progress_from_page integer,
        progress_to_page integer,
        homework_from_page integer,
        homework_to_page integer,
        homework_amount varchar(100),
        rep_version bigint NOT NULL,
        issue_version integer NOT NULL,
        actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rep_book_progress_has_material CHECK (progress_from_page IS NOT NULL OR homework_from_page IS NOT NULL),
        CONSTRAINT rep_book_progress_progress_pair CHECK ((progress_from_page IS NULL) = (progress_to_page IS NULL)),
        CONSTRAINT rep_book_progress_homework_pair CHECK ((homework_from_page IS NULL) = (homework_to_page IS NULL)),
        CONSTRAINT rep_book_progress_progress_range CHECK (progress_from_page IS NULL OR (progress_from_page >= 1 AND progress_to_page >= progress_from_page)),
        CONSTRAINT rep_book_progress_homework_range CHECK (homework_from_page IS NULL OR (homework_from_page >= 1 AND homework_to_page >= homework_from_page)),
        CONSTRAINT rep_book_progress_versions_positive CHECK (rep_version >= 1 AND issue_version >= 1),
        CONSTRAINT rep_book_progress_rep_issue_unique UNIQUE (rep_id, issue_id)
      )
    `);
    await q.query(`CREATE INDEX rep_book_progress_issue_lesson_idx ON rep_book_progress(issue_id,lesson_on,id)`);

    await q.query(`
      CREATE FUNCTION rep_book_progress_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_rep rep%ROWTYPE;
        current_issue issue%ROWTYPE;
        total_pages integer;
      BEGIN
        SELECT * INTO current_rep FROM rep WHERE id=NEW.rep_id;
        SELECT * INTO current_issue FROM issue WHERE id=NEW.issue_id;
        SELECT pages INTO total_pages FROM lib WHERE id=NEW.lib_id;
        IF current_rep.id IS NULL OR current_issue.id IS NULL THEN
          RAISE EXCEPTION 'report progress source is missing'
            USING ERRCODE='23514', CONSTRAINT='rep_book_progress_source';
        END IF;
        IF current_rep.format_version <> 1 OR NEW.lesson_on <> current_rep.on_date
           OR NEW.rep_version <> current_rep.row_version THEN
          RAISE EXCEPTION 'report progress must match the current structured report version'
            USING ERRCODE='23514', CONSTRAINT='rep_book_progress_report_snapshot';
        END IF;
        IF current_issue.state NOT IN ('wait','auto','ok')
           OR NEW.lib_id <> current_issue.lib_id
           OR NEW.vers_id IS DISTINCT FROM current_issue.vers_id
           OR NEW.student_id <> current_issue.student_id
           OR NEW.issue_version > current_issue.row_version THEN
          RAISE EXCEPTION 'report progress must match an active issue snapshot'
            USING ERRCODE='23514', CONSTRAINT='rep_book_progress_issue_snapshot';
        END IF;
        IF total_pages IS NOT NULL AND (
          COALESCE(NEW.progress_to_page,0) > total_pages OR COALESCE(NEW.homework_to_page,0) > total_pages
        ) THEN
          RAISE EXCEPTION 'report progress page exceeds the book total'
            USING ERRCODE='23514', CONSTRAINT='rep_book_progress_page_limit';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END
      $$
    `);
    await q.query(`CREATE TRIGGER rep_book_progress_guard
      BEFORE INSERT OR UPDATE ON rep_book_progress FOR EACH ROW EXECUTE FUNCTION rep_book_progress_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM rep_book_progress) THEN
        RAISE EXCEPTION 'ReportBookProgress down would discard report progress history';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER IF EXISTS rep_book_progress_guard ON rep_book_progress`);
    await q.query(`DROP FUNCTION IF EXISTS rep_book_progress_guard_fn()`);
    await q.query(`DROP TABLE rep_book_progress`);
  }
}
