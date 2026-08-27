/**
 * TODO — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TODO_SRC_T_VALUES } from './enums';

@Entity({ name: 'todo' })
export class Todo {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  /** 준 사람 */
  @Column({ type: 'bigint', nullable: true })
  fromId: number | null;

  /** 받은 사람 */
  @Column({ type: 'bigint', nullable: true })
  toId: number | null;

  @Column({ type: 'date', nullable: true })
  dueOn: string | null;

  @Column({ type: 'boolean', default: false })
  done: boolean;

  @Column({ type: 'enum', enum: TODO_SRC_T_VALUES, default: 'manual' })
  src: 'meeting'|'complaint'|'consulting'|'plan'|'manual';

  @Column({ type: 'bigint', nullable: true })
  mtId: number | null;

  @Column({ type: 'bigint', nullable: true })
  cplId: number | null;

  @Column({ type: 'bigint', nullable: true })
  consId: number | null;

  @Column({ type: 'bigint', nullable: true })
  planId: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
