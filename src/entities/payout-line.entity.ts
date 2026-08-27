/**
 * PAYOUT_LINE — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'payout_line' })
export class PayoutLine {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  payoutId: number;

  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  kindKey: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 2 })
  hours: string;

  /** 수업일 기준 시급 스냅샷 — 이력이 정정돼도 안 흔들린다 */
  @Column({ type: 'int' })
  unitRate: number;

  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'int', default: 0 })
  cut: number;
}
