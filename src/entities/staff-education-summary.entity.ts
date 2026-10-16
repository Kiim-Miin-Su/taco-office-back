/** @file-guide
 * 목적: staff_education_summary — 구성원 학력 요약 최대 5행.
 * 책임/재사용: 화면의 순서와 학교·전공·학위·상태만 보존한다. 기존 학교·학적 도메인과 독립이다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Check, Column, Entity, ForeignKey, PrimaryColumn } from 'typeorm';

@ForeignKey('staff', ['staffId'], ['id'], { name: 'staff_education_summary_staff_fk', onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
@Check('staff_education_summary_position', '"position" BETWEEN 0 AND 4')
@Check('staff_education_summary_school', 'char_length(btrim("school")) > 0')
@Entity({ name: 'staff_education_summary' })
export class StaffEducationSummary {
  @PrimaryColumn({ type: 'bigint' }) staffId: number;
  @PrimaryColumn({ type: 'smallint' }) position: number;
  @Column({ type: 'varchar', length: 120 }) school: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) major: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) degree: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) status: string | null;
}
