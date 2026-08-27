/**
 * CHREQ — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'chreq' })
export class Chreq {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  /** time | teacher | room | off */
  @Column({ type: 'varchar', length: 12 })
  reqType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'text' })
  reason: string;

  /** open | applied | denied */
  @Column({ type: 'varchar', length: 12, default: 'open' })
  state: string;

  @Column({ type: 'bigint' })
  byId: number;

  @Column({ type: 'bigint', nullable: true })
  resolvedBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** 정기 수업이면 이후 전체 적용 */
  @Column({ type: 'boolean', default: false })
  applyAll: boolean;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
