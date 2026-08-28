/**
 * WAGE — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['staffId', 'fromDate'], { unique: true })
@Entity({ name: 'wage' })
export class Wage {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  staffId: number;

  /** 기본 시급(원/시간) */
  @Column({ type: 'int' })
  rate: number;

  /** 이 날짜의 수업부터 적용 — 소급 없음 (D8 확정) */
  @Column({ type: 'date' })
  fromDate: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint', nullable: true })
  approvedBy: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
