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
// C92 수동 CHECK metadata: migration 1760500000000 과 함께 보존/검증한다 — lib/rules.cancelPolicyIssue 와 같은 규칙.
@Check('exc_makeup_link', "makeup_ser_id IS NULL OR cancel_treat = 'makeup'")
@Check('exc_cancel_policy', "(cancel_kind IS NULL OR cancel_kind IN ('teacher_absent','student_absent','academy','holiday','other')) AND (cancel_treat IS NULL OR cancel_treat IN ('carry','deduct','makeup')) AND (cancel_treat IS NULL OR (canceled AND cancel_kind IS NOT NULL)) AND (cancel_treat IS DISTINCT FROM 'deduct' OR cancel_kind = 'student_absent')")
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

  /**
   * 휴강 사유 — 출결 취소 사유와 같은 다섯 낱말 (`lib/rules.ATTENDANCE_CANCEL_REASONS` · C92).
   * 휴강(canceled)일 때만 값이 있고, 옛 휴강 행은 NULL 로 남는다 — 보정하지 않는다 (N-25).
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  cancelKind: string | null;

  /**
   * 휴강 처리 — carry(이월) · deduct(차감) · makeup(보강 이관) (`lib/rules.CANCEL_TREATS`).
   * NULL 은 기본 정책(이월)으로 읽는다. 차감은 학생 결석에만 허용된다 — `exc_cancel_policy` CHECK.
   */
  @Column({ type: 'varchar', length: 8, nullable: true })
  cancelTreat: string | null;

  /**
   * 보강 이관이면 보강 회차(ONCE 규칙)의 SER id (C92-b · C-34). FK ON DELETE SET NULL —
   * 보강을 지우면 링크만 풀리고 원래 회차의 휴강은 남는다. 처리가 makeup 일 때만 값이 있다 (`exc_makeup_link`).
   */
  @Column({ type: 'bigint', nullable: true })
  makeupSerId: number | null;

  @Column({ type: 'bigint', nullable: true })
  byId: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;
}
