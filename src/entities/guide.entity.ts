/**
 * GUIDE — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { GUIDE_STATE_T_VALUES } from './enums';

@Entity({ name: 'guide' })
export class Guide {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  /** new(첫 수업) | teacher_change */
  @Column({ type: 'varchar', length: 12 })
  reason: string;

  @Column({ type: 'enum', enum: GUIDE_STATE_T_VALUES, default: 'draft' })
  state: 'draft'|'ready'|'sent'|'read';

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'date', nullable: true })
  dueOn: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
