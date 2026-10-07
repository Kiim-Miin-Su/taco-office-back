/** @file-guide
 * 목적: BOC-03D-04b 명시 형제·자매 정렬 pair의 ORM 매핑.
 * 책임/재사용: 한 관계를 low/high 한 행으로 저장한다. 보호자 연락처 추론 관계와 합치지 않는다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/contracts/db/student-registration-target.dbml
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Check('stu_sibling_order', 'student_low_id < student_high_id')
@Index('stu_sibling_reverse', ['studentHighId', 'active', 'studentLowId'])
@ForeignKey('stu', ['studentLowId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('stu', ['studentHighId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['linkedBy'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Entity({ name: 'stu_sibling' })
export class StuSibling {
  @PrimaryColumn({ type: 'bigint' }) studentLowId: number;
  @PrimaryColumn({ type: 'bigint' }) studentHighId: number;
  @Column({ type: 'boolean', default: true }) active: boolean;
  @Column({ type: 'bigint' }) linkedBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) linkedAt: Date;
}
