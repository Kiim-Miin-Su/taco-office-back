/**
 * SER — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CLASS_MODE_T_VALUES } from './enums';

@Index(['fromDate', 'toDate'])
@Index(['teacherId'])
@Index(['roomId'])
@Entity({ name: 'ser' })
export class Ser {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 16 })
  kindKey: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  subKey: string | null;

  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  @Column({ type: 'bigint', nullable: true })
  roomId: number | null;

  @Column({ type: 'enum', enum: CLASS_MODE_T_VALUES })
  mode: 'offline'|'online';

  /** 0~1439 분 단위 정수 */
  @Column({ type: 'smallint' })
  startMin: number;

  @Column({ type: 'smallint' })
  endMin: number;

  /** 반복 규칙 — 요일·주기·기간 */
  @Column({ type: 'varchar', length: 80 })
  rrule: string;

  @Column({ type: 'date' })
  fromDate: string;

  @Column({ type: 'date', nullable: true })
  toDate: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  title: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
