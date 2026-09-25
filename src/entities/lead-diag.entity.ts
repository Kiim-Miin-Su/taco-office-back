/** @file-guide
 * 목적: lead_diag 테이블 ORM 매핑 — LeadDiag (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * LEAD_DIAG — 상담 단계 진단 점수 원장 (append-only · DQ1 2026-09-25 · N-53 · v4.42).
 *
 * 영어 · 수학 · 인터뷰 **점수만** 적고, 레벨·교재는 **담당자가 고른 값**을 적는다(자동 판정·자동 배치 없음).
 * 가장 최근 줄이 지금 값이다. 등록되면 `lead.student_id` 를 따라 그 학생의 것으로 읽는다 —
 * 값을 강사 진단 리포트(DIAG)로 옮겨 적지 않는다(두 곳에 같은 사실을 두지 않는다 · D-R22).
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['leadId', 'id'])
@Check('lead_diag_score_nonneg', '(english IS NULL OR english >= 0) AND (math IS NULL OR math >= 0) AND (interview IS NULL OR interview >= 0)')
@Check('lead_diag_level_words', "level IS NULL OR level IN ('foundation','practice','master')")
@Check('lead_diag_not_empty', 'english IS NOT NULL OR math IS NOT NULL OR interview IS NOT NULL OR level IS NOT NULL OR book_id IS NOT NULL')
@Entity({ name: 'lead_diag' })
export class LeadDiag {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  leadId: number;

  /** 영어 점수 — 0 이상. 만점은 정해지지 않아 위 끝을 두지 않는다 (DQ1) */
  @Column({ type: 'integer', nullable: true })
  english: number | null;

  @Column({ type: 'integer', nullable: true })
  math: number | null;

  @Column({ type: 'integer', nullable: true })
  interview: number | null;

  /** 진단고사를 본 날 — 모르면 NULL */
  @Column({ type: 'date', nullable: true })
  takenOn: string | null;

  /** foundation | practice | master — 담당자가 고른다. 낱말은 lib/lead-diag-words */
  @Column({ type: 'varchar', length: 12, nullable: true })
  level: string | null;

  /** 담당자가 고른 교재(LIB) */
  @Column({ type: 'bigint', nullable: true })
  bookId: number | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'bigint' })
  createdBy: number;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
