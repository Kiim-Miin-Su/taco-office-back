/**
 * CPL — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CPL_AREA_T_VALUES } from './enums';

@Entity({ name: 'cpl' })
export class Cpl {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'enum', enum: CPL_AREA_T_VALUES })
  area: 'lesson'|'intake'|'book'|'schedule'|'teacher';

  @Column({ type: 'bigint', nullable: true })
  studentId: number | null;

  /** open | acting | done */
  @Column({ type: 'varchar', length: 12 })
  stage: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', nullable: true })
  action: string | null;

  @Column({ type: 'text', nullable: true })
  result: string | null;

  @Column({ type: 'boolean', default: false })
  teacherChanged: boolean;

  @Column({ type: 'bigint', nullable: true })
  ownerId: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
