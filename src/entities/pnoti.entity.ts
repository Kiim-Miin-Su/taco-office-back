/** @file-guide
 * 목적: pnoti 테이블 ORM 매핑 — Pnoti (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * PNOTI — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PNOTI_AUDIENCE_T_VALUES } from './enums';

@Index(['serId', 'onDate'])
@Index(['studentId', 'onDate'])
@ForeignKey('ser', ['serId'], ['id'], { name: 'pnoti_ser_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('stu', ['studentId'], ['id'], { name: 'pnoti_student_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Check('pnoti_channel_valid', "channel IN ('sms','kakao','email','app')")
@Check('pnoti_audience_target', "(audience = 'parent' AND student_id IS NOT NULL AND staff_id IS NULL) OR (audience = 'teacher' AND staff_id IS NOT NULL AND student_id IS NULL)")
@ForeignKey('staff', ['staffId'], ['id'], { name: 'pnoti_staff_id_fk', onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
@Entity({ name: 'pnoti' })
export class Pnoti {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  /**
   * 전달 대상 — §43 「매번」이 줄마다 학부모·강사를 **따로** 체크한다 (C82-b).
   * 기존 행은 전부 `parent` 다: 이 표의 정의가 「학부모 안내」이고 `student_id` 가
   * NOT NULL 이었으므로 다른 값일 수 없었다.
   */
  @Column({ type: 'enum', enum: PNOTI_AUDIENCE_T_VALUES, enumName: 'pnoti_audience_t', default: 'parent' })
  audience: 'parent' | 'teacher';

  /** 학부모 행에만 있다 */
  @Column({ type: 'bigint', nullable: true })
  studentId: number | null;

  /** 강사 행에만 있다 */
  @Column({ type: 'bigint', nullable: true })
  staffId: number | null;

  @Column({ type: 'varchar', length: 10 })
  channel: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;
}
