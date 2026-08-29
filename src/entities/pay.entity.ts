/**
 * PAY — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['invId'])
@Index(['paidOn'])
@Entity({ name: 'pay' })
export class Pay {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** NULL 이면 매니저가 직접 넣은 건 (A-D1) */
  @Column({ type: 'bigint', nullable: true })
  invId: number | null;

  @Column({ type: 'bigint', nullable: true })
  studentId: number | null;

  /** 실제 입금액. NULL = 아직 아무도 확인하지 않음 */
  @Column({ type: 'int', nullable: true })
  amount: number | null;

  @Column({ type: 'date', nullable: true })
  paidOn: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  method: string | null;

  /** 청구액과 다를 때 필수 */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint', nullable: true })
  enteredBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  enteredAt: Date | null;

  /** 확정 — 매니저 이상 (D-R39 · D-R37) */
  @Column({ type: 'bigint', nullable: true })
  confirmedBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;
}
