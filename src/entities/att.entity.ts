/**
 * ATT — docs/contracts/db/erd.dbml v4.9에서 생성한 회차 출결 현재값입니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['serId', 'onDate'], { unique: true })
@Index(['confirmedBy', 'confirmedAt'])
@Entity({ name: 'att' })
export class Att {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  serId: number;

  @Column({ type: 'date' })
  onDate: string;

  @Column({ type: 'varchar', length: 12 })
  result: 'completed' | 'canceled';

  @Column({ type: 'varchar', length: 24, nullable: true })
  reason: 'teacher_absent' | 'student_absent' | 'academy' | 'holiday' | 'other' | null;

  @Column({ type: 'bigint' })
  confirmedBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  confirmedAt: Date;
}
