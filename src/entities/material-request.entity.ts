/** @file-guide
 * 목적: 최신 강사 일반 자료요청의 현재 상태와 담당·전달·확인 시각을 보존한다.
 * 책임/재사용: 현재 projection만 소유하며 모든 전이와 멱등 증거는 material_request_event를 따른다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · docs/contracts/db/erd.dbml
 */

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'material_request' })
@Unique('material_request_teacher_key_unique', ['teacherId', 'requestKey'])
@Index('material_request_state_needed_idx', ['state', 'neededOn', 'id'])
@Index('material_request_teacher_created_idx', ['teacherId', 'createdAt', 'id'])
@ForeignKey('staff', ['teacherId'], ['id'], { name: 'material_request_teacher_fk', onDelete: 'RESTRICT' })
@ForeignKey('stu', ['studentId'], ['id'], { name: 'material_request_student_fk', onDelete: 'RESTRICT' })
@ForeignKey('staff', ['assignedTo'], ['id'], { name: 'material_request_assigned_fk', onDelete: 'RESTRICT' })
@ForeignKey('staff', ['deliveredBy'], ['id'], { name: 'material_request_delivered_by_fk', onDelete: 'RESTRICT' })
@Check('material_request_kind_words', "\"kind\" IN ('book_pdf','worksheet','test_paper','other')")
@Check('material_request_state_words', "\"state\" IN ('received','preparing','delivered','rejected')")
@Check('material_request_body_present', "length(btrim(\"body\")) BETWEEN 1 AND 2000")
@Check('material_request_version_positive', '"row_version" >= 1')
@Check('material_request_state_shape', `
  ("state"='received' AND "assigned_to" IS NULL AND "delivered_at" IS NULL AND "delivered_by" IS NULL AND "rejected_at" IS NULL AND "reject_reason" IS NULL AND "acknowledged_at" IS NULL)
  OR ("state"='preparing' AND "assigned_to" IS NOT NULL AND "delivered_at" IS NULL AND "delivered_by" IS NULL AND "rejected_at" IS NULL AND "reject_reason" IS NULL AND "acknowledged_at" IS NULL)
  OR ("state"='delivered' AND "assigned_to" IS NOT NULL AND "delivered_at" IS NOT NULL AND "delivered_by" IS NOT NULL AND "rejected_at" IS NULL AND "reject_reason" IS NULL)
  OR ("state"='rejected' AND "rejected_at" IS NOT NULL AND length(btrim("reject_reason")) >= 2 AND "delivered_at" IS NULL AND "delivered_by" IS NULL AND "acknowledged_at" IS NULL)
`)
export class MaterialRequest {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) teacherId: number;
  @Column({ type: 'bigint' }) studentId: number;
  @Column({ type: 'varchar', length: 20 }) kind: string;
  @Column({ type: 'date' }) neededOn: string;
  @Column({ type: 'varchar', length: 2000 }) body: string;
  @Column({ type: 'varchar', length: 16, default: 'received' }) state: string;
  @Column({ type: 'int', default: 1 }) rowVersion: number;
  @Column({ type: 'uuid' }) requestKey: string;
  @Column({ type: 'bigint', nullable: true }) assignedTo: number | null;
  @Column({ type: 'bigint', nullable: true }) deliveredBy: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) rejectReason: string | null;
  @Column({ type: 'timestamptz', nullable: true }) deliveredAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) rejectedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) acknowledgedAt: Date | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}
