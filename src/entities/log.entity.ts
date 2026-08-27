/**
 * LOG — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['entity', 'entityId', 'at'])
@Entity({ name: 'log' })
export class Log {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  actorId: number;

  @Column({ type: 'varchar', length: 20 })
  entity: string;

  @Column({ type: 'bigint' })
  entityId: number;

  @Column({ type: 'varchar', length: 20 })
  action: string;

  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;
}
