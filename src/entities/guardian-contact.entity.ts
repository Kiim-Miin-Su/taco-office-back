/** @file-guide
 * 목적: ST1-b3a guardian_contact의 additive ORM 매핑.
 * 책임/재사용: 현재 선택 수신처와 보존된 이전 연락처 행만 기술한다. 구형 guardian 칼럼은 후속 계약까지 유지한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index('guardian_contact_owner_active', ['guardianId', 'active'])
@Index('guardian_contact_one_selected_kind', ['guardianId', 'kind'], { unique: true, where: '"is_delivery_selected"' })
@ForeignKey('guardian', ['guardianId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['createdBy'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Check('guardian_contact_kind', "kind IN ('phone','kakao','email','other')")
@Check('guardian_contact_value', 'value = btrim(value) AND length(value) > 0')
@Check('guardian_contact_label', "(kind = 'other' AND label IS NOT NULL AND length(btrim(label)) > 0) OR (kind <> 'other' AND label IS NULL)")
@Check('guardian_contact_origin', "(origin = 'user' AND created_by IS NOT NULL) OR (origin = 'legacy_copy' AND created_by IS NULL)")
@Check('guardian_contact_selected', "NOT is_delivery_selected OR (active AND kind IN ('email','phone'))")
@Check('guardian_contact_email_shape', "kind <> 'email' OR value ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'")
@Check('guardian_contact_phone_shape', "kind <> 'phone' OR value ~ '^0[0-9]{9,10}$' OR value ~ '^\\+[1-9][0-9]{7,14}$'")
@Entity({ name: 'guardian_contact' })
export class GuardianContact {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) guardianId: number;
  @Column({ type: 'varchar', length: 5 }) kind: string;
  @Column({ type: 'varchar', length: 254 }) value: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) label: string | null;
  @Column({ type: 'boolean', default: true }) active: boolean;
  @Column({ type: 'boolean', default: false }) isDeliverySelected: boolean;
  @Column({ type: 'varchar', length: 11, default: 'user' }) origin: string;
  @Column({ type: 'bigint', nullable: true }) createdBy: number | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
