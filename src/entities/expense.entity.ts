/** @file-guide
 * 목적: expense 테이블 ORM 매핑 — Expense (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * EXPENSE — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['state', 'createdAt'])
@Index(['spendOn'])
@Entity({ name: 'expense' })
export class Expense {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'date' })
  spendOn: string;

  /**
   * 간이 5분류(A-D5) + 임대료 — rent | book | supply | ent | fee | etc.
   * CHECK expense_category_code (migration 1758500000000). 라벨은 DTO 가 소유한다.
   */
  @Column({ type: 'varchar', length: 30 })
  category: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  merchant: string | null;

  @Column({ type: 'text', nullable: true })
  purpose: string | null;

  /** 법인카드 — 직원이 올린 금액. placeholder 로 쓰인다 */
  @Column({ type: 'int', nullable: true })
  requestedAmount: number | null;

  /** 확정 금액. 승인자가 넣는다. NULL = 미심사 */
  @Column({ type: 'int', nullable: true })
  amount: number | null;

  /** 신청액과 다를 때 필수 */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** 없으면 승인 불가 */
  @Column({ type: 'text', nullable: true })
  receiptUrl: string | null;

  @Column({ type: 'bigint', nullable: true })
  requesterId: number | null;

  /**
   * pending | approved | rejected — **DB 기본값은 `pending`** 이다
   * (migration 1756800000000 이 낱말을 옮겼고 1758500000000 이 CHECK 로 굳혔다).
   * 여기에 `'submitted'` 가 남아 있던 동안 새 행이 대표 보고의 지출 집계(`state='approved'`)에서
   * 조용히 빠질 수 있었다 — 2026-09-12(C36-b) 교정.
   */
  @Column({ type: 'varchar', length: 12, default: 'pending' })
  state: string;

  @Column({ type: 'bigint', nullable: true })
  reviewerId: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
