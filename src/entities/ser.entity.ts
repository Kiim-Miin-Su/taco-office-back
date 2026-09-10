/** @file-guide
 * 목적: ser 테이블 ORM 매핑 — Ser (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * SER — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn, ForeignKey } from 'typeorm';
import { CLASS_MODE_T_VALUES } from './enums';

@Index(['fromDate', 'toDate'])
@Index(['teacherId'])
@Index(['roomId'])
// D3-b2b 수동 보강: 재생성 시 migration 13 / DBML 12참조와 함께 보존한다.
@ForeignKey('kind', ['kindKey'], ['key'], { name: 'ser_kind_key_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('sub', ['subKey'], ['key'], { name: 'ser_sub_key_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['teacherId'], ['id'], { name: 'ser_teacher_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('room', ['roomId'], ['id'], { name: 'ser_room_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
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

  @Column({ type: 'enum', enum: CLASS_MODE_T_VALUES, enumName: 'class_mode_t' })
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
