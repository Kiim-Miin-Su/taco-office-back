/** @file-guide
 * 목적: exc 테이블 ORM 매핑 — Exc (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * EXC — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn, ForeignKey, Check } from 'typeorm';

@Index(['serId', 'onDate'], { unique: true })
// D3-b2b 수동 보강: 재생성 시 migration 13 / DBML 12참조와 함께 보존한다.
@ForeignKey('ser', ['serId'], ['id'], { name: 'exc_ser_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['teacherId'], ['id'], { name: 'exc_teacher_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('room', ['roomId'], ['id'], { name: 'exc_room_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['byId'], ['id'], { name: 'exc_by_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
// D3-d2 수동 CHECK metadata: migration14와 함께 보존/검증한다.
@Check('exc_time_check', "(start_min IS NULL OR start_min BETWEEN 0 AND 1439) AND (end_min IS NULL OR end_min BETWEEN 1 AND 1440) AND (start_min IS NULL OR end_min IS NULL OR end_min - start_min BETWEEN 10 AND 480)")
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

  /** false면 SER 강사를 상속, true면 teacherId(null 포함)가 이 회차의 값 */
  @Column({ type: 'boolean', default: false })
  teacherSet: boolean;

  /** 강사 교체 */
  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  /** false면 SER 강의실을 상속, true면 roomId(null 포함)가 이 회차의 값 */
  @Column({ type: 'boolean', default: false })
  roomSet: boolean;

  @Column({ type: 'bigint', nullable: true })
  roomId: number | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint', nullable: true })
  byId: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;
}
