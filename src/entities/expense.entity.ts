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

  /** 임대료 · 부대비용 · 도서교재비 · 소모품비 · 접대비 · 지급수수료 (A-D5) */
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

  /** submitted | approved | rejected */
  @Column({ type: 'varchar', length: 12, default: 'submitted' })
  state: string;

  @Column({ type: 'bigint', nullable: true })
  reviewerId: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
