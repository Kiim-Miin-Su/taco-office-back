/**
 * PLAN — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'plan' })
export class Plan {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  /** draft | review | rework | ok | done */
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

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
