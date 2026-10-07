/** @file-guide
 * 목적: 학생 Kinder 명시 표식의 효력 시각·version·actor append-only ORM 매핑.
 * 책임/재사용: 학년/나이 추정 없이 실제 수업 시작 시점의 마지막 표식만 급여·리포트·명단 검증이 공유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-09D2-PAYOUT-CALCULATOR-2026-10-08.md · docs/contracts/db/erd.dbml
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Check('stu_kinder_marker_version_positive', 'version >= 1')
@Index('stu_kinder_marker_student_version_uniq', ['studentId', 'version'], { unique: true })
@Index('stu_kinder_marker_student_effective_uniq', ['studentId', 'effectiveFrom'], { unique: true })
@Entity({ name: 'stu_kinder_marker' })
export class StuKinderMarker {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) studentId: number;
  @Column({ type: 'integer' }) version: number;
  @Column({ type: 'boolean' }) marked: boolean;
  @Column({ type: 'timestamptz' }) effectiveFrom: Date;
  @Column({ type: 'text', nullable: true }) reason: string | null;
  @Column({ type: 'bigint' }) setBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
