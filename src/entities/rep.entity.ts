/**
 * REP — docs/contracts/db/erd.dbml v4.6 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { REP_STATE_T_VALUES } from './enums';

@Index(['serId', 'onDate'], { unique: true })
@Index(['state', 'submittedAt'])
@Index(['teacherId', 'onDate'])
@Entity({ name: 'rep' })
export class Rep {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  serId: number;

  @Column({ type: 'date' })
  onDate: string;

  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  kindKey: string | null;

  @Column({ type: 'varchar', length: 2, default: 'ko' })
  lang: string;

  /** 고정 5개 섹션 중 강사 입력 3칸 (D-R15 · D-R40) — {content, progress, homework} */
  @Column({ type: 'jsonb' })
  body: Record<string, unknown>;

  @Column({ type: 'enum', enum: REP_STATE_T_VALUES, enumName: 'rep_state_t', default: 'none' })
  state: 'na'|'plan'|'none'|'draft'|'wait'|'ok'|'rej';

  @Column({ type: 'timestamptz', nullable: true })
  writtenAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'bigint', nullable: true })
  reviewerId: number | null;

  /** state=rej 일 때 필수 (D-R13) */
  @Column({ type: 'text', nullable: true })
  rejectReason: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
