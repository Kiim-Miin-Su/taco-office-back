/**
 * UNAV — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['staffId', 'cycle', 'dow'])
@Entity({ name: 'unav' })
export class Unav {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  staffId: number;

  /** 입사일 기준 N번째 2주 회차 (v26) */
  @Column({ type: 'smallint', nullable: true })
  cycle: number | null;

  /** 0=일 … 6=토 */
  @Column({ type: 'smallint' })
  dow: number;

  @Column({ type: 'smallint' })
  startMin: number;

  @Column({ type: 'smallint' })
  endMin: number;

  /** v26 — 필수. 관리자가 조정 가능성을 판단한다 */
  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
