/** @file-guide
 * 목적: att 테이블 ORM 매핑 — Att (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
