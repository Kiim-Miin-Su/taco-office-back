/** @file-guide
 * 목적: lib 테이블 ORM 매핑 — Lib (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * LIB — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Check('lib_book_category_needs_subject', 'book_category_key IS NULL OR book_subject_key IS NOT NULL')
@Check('lib_book_level_words', "book_level IS NULL OR book_level IN ('foundation','practice','master')")
@Check('lib_grade_range', '(grade_from IS NULL AND grade_to IS NULL) OR (grade_from IS NOT NULL AND grade_to IS NOT NULL AND grade_from BETWEEN 0 AND 12 AND grade_to BETWEEN 0 AND 12 AND grade_from <= grade_to)')
@Check('lib_exam_tag_words', "exam_tag IS NULL OR exam_tag IN ('sat','map','isee_ssat')")
@Entity({ name: 'lib' })
export class Lib {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 30, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  subKey: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  level: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  grade: string | null;

  @Column({ type: 'smallint', nullable: true })
  pages: number | null;

  /** SE 학생용 · TE 교사용 */
  @Column({ type: 'varchar', length: 4, nullable: true })
  seTe: string | null;

  /* ── §39 두 층 분류 (N-47 채택 · W11) — 옛 칸(sub_key · level · grade)은 그대로 두고 새 칸을 사람이 채운다 ── */

  /** 교재 과목(BOOK_SUBJECT) — NULL 이면 「미분류」 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  bookSubjectKey: string | null;

  /** 교재 소분류(BOOK_CATEGORY) — 고른 과목의 것만(두 칸 FK) */
  @Column({ type: 'varchar', length: 30, nullable: true })
  bookCategoryKey: string | null;

  /** foundation | practice | master — 낱말은 lib/book(BOOK_LEVELS) */
  @Column({ type: 'varchar', length: 12, nullable: true })
  bookLevel: string | null;

  /** 학년 범위 시작 — K = 0 · G1~G12 = 1~12. 끝과 함께 비거나 함께 찬다 */
  @Column({ type: 'smallint', nullable: true })
  gradeFrom: number | null;

  @Column({ type: 'smallint', nullable: true })
  gradeTo: number | null;

  /** sat | map | isee_ssat — 원문 카드 칩 SAT · MAP · ISEE / SSAT */
  @Column({ type: 'varchar', length: 12, nullable: true })
  examTag: string | null;
}
