/** @file-guide
 * 목적: staff_teaching_kind — 구성원의 가능 수업 유형(KIND) 매핑.
 * 책임/재사용: SUBJECT 과목과 분리하고 class/mock/study만 허용하는 DB 제약과 함께 유지한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Check, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@ForeignKey('staff', ['staffId'], ['id'], { name: 'staff_teaching_kind_staff_fk', onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
@ForeignKey('kind', ['kindKey'], ['key'], { name: 'staff_teaching_kind_kind_fk', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
@Check('staff_teaching_kind_allowed', "\"kind_key\" IN ('class','mock','study')")
@Index('staff_teaching_kind_kind_idx', ['kindKey'])
@Entity({ name: 'staff_teaching_kind' })
export class StaffTeachingKind {
  @PrimaryColumn({ type: 'bigint' }) staffId: number;
  @PrimaryColumn({ type: 'varchar', length: 16 }) kindKey: string;
}
