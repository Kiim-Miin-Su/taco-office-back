/** @file-guide
 * 목적: staff_teaching_subject — 구성원의 가능 과목(SUB) 매핑. 10/14 PPTX p8 결정(2026-10-16).
 * 책임/재사용: 수업·모의수업·자습 과목만 연결한다(migration 1769800000000 트리거). staff_teaching_kind(127)는 읽기 전용 이전 입력이다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@ForeignKey('staff', ['staffId'], ['id'], { name: 'staff_teaching_subject_staff_fk', onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
@ForeignKey('sub', ['subKey'], ['key'], { name: 'staff_teaching_subject_sub_fk', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
@Index('staff_teaching_subject_sub_idx', ['subKey'])
@Entity({ name: 'staff_teaching_subject' })
export class StaffTeachingSubject {
  @PrimaryColumn({ type: 'bigint' }) staffId: number;
  @PrimaryColumn({ type: 'varchar', length: 20 }) subKey: string;
}
