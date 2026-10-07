/** @file-guide
 * 목적: BOC-03D-04b 학생 복수 담당자 연결의 ORM 매핑.
 * 책임/재사용: 현재 연결과 최초 배정 actor/시각 컬럼만 기술한다. 권한·활성 검사는 StudentsService가 소유한다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/contracts/db/student-registration-target.dbml
 */
import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Index('stu_staff_reverse', ['staffId', 'active', 'studentId'])
@ForeignKey('stu', ['studentId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['staffId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['assignedBy'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Entity({ name: 'stu_staff' })
export class StuStaff {
  @PrimaryColumn({ type: 'bigint' }) studentId: number;
  @PrimaryColumn({ type: 'bigint' }) staffId: number;
  @Column({ type: 'boolean', default: true }) active: boolean;
  @Column({ type: 'bigint' }) assignedBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) assignedAt: Date;
}
