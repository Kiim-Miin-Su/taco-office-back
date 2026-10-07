/** @file-guide
 * 목적: BOC-03D-04a 학생 본인 연락처의 additive ORM 매핑.
 * 책임/재사용: 학생 연락처 0개 허용·actor와 기본 DB 제약만 기술한다. 권한·감사 writer·발송 동의는 후속 계약이다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index('stu_contact_owner_active', ['studentId', 'active'])
@ForeignKey('stu', ['studentId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['createdBy'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Check('stu_contact_kind', "kind IN ('phone','kakao','email','other')")
@Check('stu_contact_value', 'value = btrim(value) AND length(value) > 0')
// BOC-03D-04a 권고안 채택(2026-10-07): label은 other에만 허용한다. DTO·migration·DBML을 함께 바꾼다.
@Check('stu_contact_label', "(kind = 'other' AND label IS NOT NULL AND label = btrim(label) AND length(label) > 0) OR (kind <> 'other' AND label IS NULL)")
@Check('stu_contact_email_shape', "kind <> 'email' OR value ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'")
@Check('stu_contact_phone_shape', "kind <> 'phone' OR value ~ '^0[0-9]{9,10}$' OR value ~ '^\\+[1-9][0-9]{7,14}$'")
@Entity({ name: 'stu_contact' })
export class StuContact {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) studentId: number;
  @Column({ type: 'varchar', length: 5 }) kind: string;
  @Column({ type: 'varchar', length: 254 }) value: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) label: string | null;
  @Column({ type: 'boolean', default: true }) active: boolean;
  @Column({ type: 'bigint' }) createdBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
