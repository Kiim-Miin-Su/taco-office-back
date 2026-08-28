/**
 * PAYOUT — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['staffId', 'yearMonth'], { unique: true })
@Entity({ name: 'payout' })
export class Payout {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  staffId: number;

  @Column({ type: 'varchar', length: 7 })
  yearMonth: string;

  /** 취소·휴강 제외 (D-R11) */
  @Column({ type: 'numeric', precision: 6, scale: 2 })
  hours: string;

  @Column({ type: 'int' })
  gross: number;

  /** 리포트 지각 차감 — 1시간↑ 5,000 · 4시간↑ 10,000 (D-R32) */
  @Column({ type: 'int', default: 0 })
  lateRepCut: number;

  /** 수업 지각 차감(분 단위) */
  @Column({ type: 'int', default: 0 })
  lateClsCut: number;

  /** 소득세 3% · 원 단위 절사 (D-15) */
  @Column({ type: 'int', default: 0 })
  incomeTax: number;

  /** 지방소득세 = 소득세 10% · 원 단위 절사 */
  @Column({ type: 'int', default: 0 })
  localTax: number;

  @Column({ type: 'int' })
  net: number;

  /** draft | confirmed | paid */
  @Column({ type: 'varchar', length: 12, default: 'draft' })
  state: string;

  @Column({ type: 'bigint', nullable: true })
  confirmedBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;
}
