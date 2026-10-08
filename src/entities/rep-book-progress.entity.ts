/** @file-guide
 * 목적: 구조화 리포트에서 확정한 교재 진도·숙제 범위를 수업별 원장으로 보존한다.
 * 책임/재사용: REP 본문 snapshot과 ISSUE 현재 진도 사이의 영속 관계만 매핑한다. 계산·권한은 ReportsService가 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D1-REPORT-BOOK-PROGRESS-2026-10-09.md · docs/contracts/db/erd.dbml
 */

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * BOC-08D-01 권고안: 리포트 본문은 당시 표시용 snapshot으로 남기고, 교재 화면은 이 원장을 읽는다.
 * 정책을 바꾸면 ReportMaterialDto·ReportsService·BookTracking·두 DBML·BOC-08 문서·portfolio를 함께 고친다.
 */
@Index('rep_book_progress_rep_issue_unique', ['repId', 'issueId'], { unique: true })
@Index('rep_book_progress_issue_lesson_idx', ['issueId', 'lessonOn', 'id'])
@ForeignKey('rep', ['repId'], ['id'], { name: 'rep_book_progress_rep_fk', onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
@ForeignKey('issue', ['issueId'], ['id'], { name: 'rep_book_progress_issue_fk', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
@ForeignKey('lib', ['libId'], ['id'], { name: 'rep_book_progress_lib_fk', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
@ForeignKey('vers', ['versId'], ['id'], { name: 'rep_book_progress_vers_fk', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
@ForeignKey('stu', ['studentId'], ['id'], { name: 'rep_book_progress_student_fk', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['actorId'], ['id'], { name: 'rep_book_progress_actor_fk', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
@Check('rep_book_progress_has_material', 'progress_from_page IS NOT NULL OR homework_from_page IS NOT NULL')
@Check('rep_book_progress_progress_pair', '(progress_from_page IS NULL) = (progress_to_page IS NULL)')
@Check('rep_book_progress_homework_pair', '(homework_from_page IS NULL) = (homework_to_page IS NULL)')
@Check('rep_book_progress_progress_range', 'progress_from_page IS NULL OR (progress_from_page >= 1 AND progress_to_page >= progress_from_page)')
@Check('rep_book_progress_homework_range', 'homework_from_page IS NULL OR (homework_from_page >= 1 AND homework_to_page >= homework_from_page)')
@Check('rep_book_progress_versions_positive', 'rep_version >= 1 AND issue_version >= 1')
@Entity({ name: 'rep_book_progress' })
export class RepBookProgress {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  repId: number;

  @Column({ type: 'bigint' })
  issueId: number;

  @Column({ type: 'bigint' })
  libId: number;

  @Column({ type: 'bigint', nullable: true })
  versId: number | null;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'date' })
  lessonOn: string;

  @Column({ type: 'int', nullable: true })
  progressFromPage: number | null;

  @Column({ type: 'int', nullable: true })
  progressToPage: number | null;

  @Column({ type: 'int', nullable: true })
  homeworkFromPage: number | null;

  @Column({ type: 'int', nullable: true })
  homeworkToPage: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  homeworkAmount: string | null;

  @Column({ type: 'bigint' })
  repVersion: number;

  @Column({ type: 'int' })
  issueVersion: number;

  @Column({ type: 'bigint' })
  actorId: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
