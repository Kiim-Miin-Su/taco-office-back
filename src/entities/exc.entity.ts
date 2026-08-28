/**
 * EXC — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['serId', 'onDate'], { unique: true })
@Entity({ name: 'exc' })
export class Exc {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  serId: number;

  /** 원래 날짜 */
  @Column({ type: 'date' })
  onDate: string;

  /** 휴강 */
  @Column({ type: 'boolean', default: false })
  canceled: boolean;

  /** 옮긴 경우 */
  @Column({ type: 'date', nullable: true })
  newDate: string | null;

  @Column({ type: 'smallint', nullable: true })
  startMin: number | null;

  @Column({ type: 'smallint', nullable: true })
  endMin: number | null;

  /** 강사 교체 */
  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  @Column({ type: 'bigint', nullable: true })
  roomId: number | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint', nullable: true })
  byId: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;
}
