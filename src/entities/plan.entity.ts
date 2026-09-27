/** @file-guide
 * 목적: plan 테이블 ORM 매핑 — Plan (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * PLAN — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Check('plan_share_words', "share IS NULL OR share IN ('all', 'picked')")
@Check('plan_due_rejected_triple', '(due_rejected_at IS NULL) = (due_rejected_by IS NULL) AND (due_rejected_at IS NULL) = (due_rejected_on IS NULL)')
@Check('plan_due_rejected_clears', 'due_rejected_at IS NULL OR due_on IS NULL')
@Entity({ name: 'plan' })
export class Plan {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  /**
   * `draft | review | rework | approved | done` — 표의 `plan_stage_words` CHECK 가 막는다 (S6).
   *
   * 한동안 이 주석과 `erd.dbml` 의 note 가 **둘 다 `ok`** 라 적고 있었다. 마이그레이션
   * `1756700000000` 이 `ok`·`done` 을 `approved` 로 접은 뒤였고, 코드가 쓰는 낱말은 줄곧
   * `approved` 였다 — **선언과 데이터가 다르면 그 차이를 읽은 쪽이 조용히 틀린다** (C86-d).
   */
  @Column({ type: 'varchar', length: 12 })
  stage: string;

  @Column({ type: 'text', nullable: true })
  goal: string | null;

  @Column({ type: 'jsonb', nullable: true })
  tasks: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  research: string | null;

  /** 결정 요청 */
  @Column({ type: 'text', nullable: true })
  ask: string | null;

  @Column({ type: 'date', nullable: true })
  dueOn: string | null;

  @Column({ type: 'bigint', nullable: true })
  ownerId: number | null;

  /** 대표가 기한을 승인한 순간 — 비어 있으면 `dueOn` 은 아직 제안이다 (원문 §61·§65 · C56) */
  @Column({ type: 'timestamptz', nullable: true })
  dueApprovedAt: Date | null;

  /** 기한을 승인한 사람 (C56) */
  @Column({ type: 'bigint', nullable: true })
  dueApprovedBy: number | null;

  /**
   * 보완 요청 사유 — **다시 올리면 지워진다** (S6).
   *
   * 지난 반려 사유가 남아 있으면 지금 상태를 속인다(C85-a 가 RPT 에서 정한 것과 같다).
   * 그래서 이것은 감사 줄이 아니라 **업무 상태**이고, `log` 에서 되짚지 않는다.
   */
  @Column({ type: 'text', nullable: true })
  reworkReason: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;

  /**
   * 공개 범위 — `all` 전체 공개 · `picked` 지정 공개 (N-72 · 원문 §61 카드 칩 두 값).
   * **NULL 은 옛 기획**이다 — 지금처럼 모두에게 보이고 칩이 서지 않는다(보정 0 · N-25).
   * 누가 볼 수 있는가는 `lib/plan-words` 의 `planCan` 한 곳이 정한다.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  share: string | null;

  /**
   * 기한 반려 보존 (N-95 · 원문 §61 「D-2 08-19 · 기한 반려」) — 반려가 지운 날짜 · 순간 · 사람.
   * 셋은 함께 있거나 함께 없고(`plan_due_rejected_triple`), 새 기한을 내면 비운다(`plan_due_rejected_clears`).
   */
  @Column({ type: 'date', nullable: true })
  dueRejectedOn: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  dueRejectedAt: Date | null;

  @Column({ type: 'bigint', nullable: true })
  dueRejectedBy: number | null;
}
