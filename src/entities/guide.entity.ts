/** @file-guide
 * 목적: guide 테이블 ORM 매핑 — Guide (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * GUIDE — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';
import { GUIDE_STATE_T_VALUES } from './enums';

@Index('guide_event_unique', ['serId', 'eventOn', 'studentId', 'reason'], {
  unique: true,
  where: '"ser_id" IS NOT NULL AND "event_on" IS NOT NULL',
})
@Index(['studentId', 'createdAt'])
@Index(['state', 'dueOn'])
@ForeignKey('ser', ['serId'], ['id'], { name: 'guide_ser_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('stu', ['studentId'], ['id'], { name: 'guide_student_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['teacherId'], ['id'], { name: 'guide_teacher_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['createdBy'], ['id'], { name: 'guide_created_by_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Check('guide_reason_valid', "reason IN ('new','teacher_change')")
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

  /** new(첫 수업) | teacher_change — 14자라 varchar(12) 에 안 들어갔다 (TBO-26) */
  @Column({ type: 'varchar', length: 20 })
  reason: string;

  @Column({ type: 'enum', enum: GUIDE_STATE_T_VALUES, enumName: 'guide_state_t', default: 'draft' })
  state: 'draft'|'ready'|'sent'|'read';

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'date', nullable: true })
  dueOn: string | null;

  /** 첫 수업·강사 교체의 원래 회차 키(on_date). SER_OCC.id는 재투영 때 바뀌므로 저장하지 않는다. */
  @Column({ type: 'date', nullable: true })
  eventOn: string | null;

  @Column({ type: 'bigint', nullable: true })
  createdBy: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
